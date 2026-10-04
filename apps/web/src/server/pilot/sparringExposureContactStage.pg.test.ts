// Real PostgreSQL-backed test for the sparring-exposure-contact-stage
// migration and the code that reads it (map item 15, PR B). './db' is routed
// into the embedded server, so sparringExposure.ts, athleteContactCaps.ts and
// access.ts run their real SQL against real rows.
//
// What needs a real database to prove:
//   * the migration adds the column from nothing, re-applies as a no-op,
//     leaves existing rows "not recorded" (null), and the runner refuses a
//     database it never reached;
//   * the ladder CHECK admits null and each rung and refuses anything else;
//   * recordSparringExposure stores the stage and reads it back;
//   * countHardOrOpenSparringDays counts gym DAYS (sessions = gym days) with a
//     hard or open segment in the 7 ending on the given day -- bounds, other
//     athletes and deleted athletes included;
//   * readCapForEntry says 'set' / 'none' / 'unknown', and a refusal is
//     'unknown', never 'none'.
//
// Disposable, local-only embedded Postgres. It NEVER connects to production
// or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
}));

import type { ActorIdentity } from './access';
import { type ContactStage, readCapForEntry } from './athleteContactCaps';
import type { PilotRole } from './contracts';
import { countHardOrOpenSparringDays, listSparringExposure, recordSparringExposure, type SparringType } from './sparringExposure';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-sparring-stage-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_sparring_exposure_contact_stage_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-sparring-exposure-contact-stage-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-stage';
const OTHER_ORG_ID = 'org-stage-elsewhere';
const ATHLETE_ACCOUNT_ID = 'acct-stage-athlete';
const COACH_ID = 'acct-stage-coach';
const UNASSIGNED_COACH_ID = 'acct-stage-unassigned';
const ATHLETE_ID = 'ath-stage-1';
const OTHER_ATHLETE_ID = 'ath-stage-2';
const DAY = '2026-10-03';

function actorFor(accountId: string, role: PilotRole): ActorIdentity {
  return { accountId, role, organizationId: ORG_ID, athleteId: null };
}
const COACH = actorFor(COACH_ID, 'coach');
const UNASSIGNED_COACH = actorFor(UNASSIGNED_COACH_ID, 'coach');

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
}

/** Full production schema, one gym, two coaches, two athletes. */
async function freshDatabase(name: string, { preMigration = false } = {}): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active'), ($2, $2, 'active')`,
    [ORG_ID, OTHER_ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id)
     values ($1, 'coach', $3, 'microsoft', null), ($2, 'coach', $3, 'microsoft', null),
            ($4, 'athlete', $3, 'microsoft', $5)`,
    [COACH_ID, UNASSIGNED_COACH_ID, ORG_ID, ATHLETE_ACCOUNT_ID, ATHLETE_ID],
  );
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $3, 'coach', true), ($2, $3, 'coach', true)`,
    [COACH_ID, UNASSIGNED_COACH_ID, ORG_ID],
  );
  // ATHLETE_ID also exists in the other gym, under the same id, as a
  // different child -- so org scoping is what keeps their rows apart.
  for (const [org, athleteId] of [[ORG_ID, ATHLETE_ID], [ORG_ID, OTHER_ATHLETE_ID], [OTHER_ORG_ID, ATHLETE_ID]]) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Stage Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
      [org, athleteId, COACH_ID],
    );
  }

  if (preMigration) {
    await client.query(
      'alter table pilot.sparring_exposure drop constraint if exists pilot_sparring_exposure_contact_stage_check',
    );
    await client.query('alter table pilot.sparring_exposure drop column if exists contact_stage');
  }
  return client;
}

async function migratedDatabase(name: string): Promise<Client> {
  const client = await freshDatabase(name);
  activeClient = client;
  return client;
}

function record(
  day: string,
  sparringType: SparringType,
  contactStage: ContactStage | null,
  athleteId = ATHLETE_ID,
) {
  return recordSparringExposure({
    organizationId: ORG_ID,
    sessionDate: day,
    athleteId,
    sparringType,
    contactStage,
    timeUnderImpactSec: 60,
    coachObservedIntensity: 'light',
    coachObservedHeadContact: 'none',
    athletePresentation: 'normal',
    supervisingCoachAccountId: COACH_ID,
  });
}

function rawInsert(client: Client, stage: string | null) {
  return client.query(
    `insert into pilot.sparring_exposure
       (organization_id, exposure_id, athlete_id, segment_number, sparring_type, time_under_impact_sec,
        coach_observed_intensity, coach_observed_head_contact, supervising_coach_account_id, session_date,
        contact_stage)
     values ($1, gen_random_uuid()::text, $2,
             (select coalesce(max(segment_number), 0) + 1 from pilot.sparring_exposure),
             'play', 60, 'light', 'none', $3, $4::date, $5)`,
    [ORG_ID, ATHLETE_ID, COACH_ID, DAY, stage],
  );
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += chunk.toString();
  });
  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: serverProcess.stdout });
    const timeout = setTimeout(() => {
      rl.close();
      reject(new Error(`Embedded Postgres did not become ready in time. stderr:\n${stderrOutput}`));
    }, 120_000);
    rl.on('line', (line) => {
      if (line.includes('EMBEDDED_PG_READY')) {
        clearTimeout(timeout);
        rl.close();
        resolve();
      }
    });
    serverProcess.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Embedded Postgres process exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
});

afterEach(() => {
  activeClient = null;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      resolve();
    };
    const safetyTimer = setTimeout(finish, 15_000);
    safetyTimer.unref();
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

describe('sparring exposure contact-stage migration', () => {
  test('adds the column from nothing; existing rows read "not recorded"; a re-apply changes nothing', async () => {
    const client = await freshDatabase('stage_fresh', { preMigration: true });
    try {
      const before = await client.query(
        `select 1 from information_schema.columns
          where table_schema = 'pilot' and table_name = 'sparring_exposure' and column_name = 'contact_stage'`,
      );
      expect(before.rows).toHaveLength(0);
      await client.query(
        `insert into pilot.sparring_exposure
           (organization_id, exposure_id, athlete_id, segment_number, sparring_type, time_under_impact_sec,
            coach_observed_intensity, coach_observed_head_contact, supervising_coach_account_id, session_date)
         values ($1, 'old-row', $2, 1, 'hard', 60, 'light', 'none', $3, $4::date)`,
        [ORG_ID, ATHLETE_ID, COACH_ID, DAY],
      );

      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const { rows } = await client.query(`select exposure_id, contact_stage from pilot.sparring_exposure`);
      expect(rows).toEqual([{ exposure_id: 'old-row', contact_stage: null }]);
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('stage_not_ready', { preMigration: true });
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /SPARRING_EXPOSURE_CONTACT_STAGE_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES the column without its ladder guard, or with a guard missing a rung', async () => {
    const client = await freshDatabase('stage_half', { preMigration: true });
    try {
      await client.query('alter table pilot.sparring_exposure add column contact_stage text null');
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /SPARRING_EXPOSURE_CONTACT_STAGE_NOT_READY/,
      );
      await client.query(
        `alter table pilot.sparring_exposure add constraint pilot_sparring_exposure_contact_stage_check
           check (contact_stage is null or contact_stage in ('none', 'light_technical', 'open_sparring'))`,
      );
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /SPARRING_EXPOSURE_CONTACT_STAGE_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the ladder CHECK admits null and every rung, and refuses anything else', async () => {
    const client = await freshDatabase('stage_check');
    try {
      for (const stage of [null, 'none', 'light_technical', 'conditioned', 'controlled_sparring', 'open_sparring']) {
        await expect(rawInsert(client, stage)).resolves.toBeDefined();
      }
      await expect(rawInsert(client, 'hard_sparring')).rejects.toThrow(/pilot_sparring_exposure_contact_stage_check/);
    } finally {
      await client.end();
    }
  });
});

describe('stage storage, the gym-day count and the cap reading', () => {
  test('the stage is stored and read back; omitted reads as null', async () => {
    const client = await migratedDatabase('stage_store');
    try {
      const saved = await record(DAY, 'technical', 'controlled_sparring');
      expect(saved.contact_stage).toBe('controlled_sparring');
      const omitted = await recordSparringExposure({
        organizationId: ORG_ID,
        sessionDate: DAY,
        athleteId: ATHLETE_ID,
        sparringType: 'play',
        timeUnderImpactSec: 30,
        coachObservedIntensity: 'light',
        coachObservedHeadContact: 'none',
        supervisingCoachAccountId: COACH_ID,
      });
      expect(omitted.contact_stage).toBeNull();
      const listed = await listSparringExposure(ORG_ID, { athleteId: ATHLETE_ID });
      expect(listed.map((row) => row.contact_stage).sort()).toEqual(['controlled_sparring', null].sort());
    } finally {
      await client.end();
    }
  });

  test('counts gym DAYS with a hard or open segment in the 7 ending on the day, and nothing else', async () => {
    const client = await migratedDatabase('stage_count');
    try {
      await record(DAY, 'hard', 'controlled_sparring'); // day 1 ...
      await record(DAY, 'hard', 'controlled_sparring'); // ... same day: still one session
      await record('2026-10-01', 'game', 'open_sparring'); // open, not "hard": counts
      await record('2026-09-30', 'technical', 'controlled_sparring'); // neither: no
      await record('2026-09-27', 'hard', null); // 7th day back, inclusive: counts
      await record('2026-09-26', 'hard', null); // 8th day back: outside
      await record(DAY, 'hard', 'open_sparring', OTHER_ATHLETE_ID); // another athlete: no
      await record('2026-10-02', 'play', 'open_sparring', OTHER_ATHLETE_ID); // (still another athlete)

      // Same athlete id in ANOTHER gym: not this child.
      await client.query(
        `insert into pilot.sparring_exposure
           (organization_id, exposure_id, athlete_id, segment_number, sparring_type, time_under_impact_sec,
            coach_observed_intensity, coach_observed_head_contact, supervising_coach_account_id, session_date)
         values ($1, 'elsewhere-1', $2, 1, 'hard', 60, 'light', 'none', $3, '2026-10-02')`,
        [OTHER_ORG_ID, ATHLETE_ID, COACH_ID],
      );

      expect(await countHardOrOpenSparringDays(ORG_ID, ATHLETE_ID, DAY)).toBe(3);

      // A LINKED segment (no session_date) counts by its activity's day.
      await client.query(
        `insert into pilot.activity_log
           (organization_id, activity_id, person_account_id, athlete_id, activity_domain, activity_type,
            occurred_on, duration_minutes, capture_method, recorded_by_role, recorded_by_account_id)
         values ($1, 'act-1', $2, $3, 'boxing_training', 'sparring_session', '2026-10-02', 60, 'door_terminal', 'coach', $4)`,
        [ORG_ID, ATHLETE_ACCOUNT_ID, ATHLETE_ID, COACH_ID],
      );
      await recordSparringExposure({
        organizationId: ORG_ID,
        activityId: 'act-1',
        athleteId: ATHLETE_ID,
        sparringType: 'hard',
        contactStage: null,
        timeUnderImpactSec: 60,
        coachObservedIntensity: 'light',
        coachObservedHeadContact: 'none',
        supervisingCoachAccountId: COACH_ID,
      });
      expect(await countHardOrOpenSparringDays(ORG_ID, ATHLETE_ID, DAY)).toBe(4);
      // ... and on that day it is one session with an unlinked open segment.
      await record('2026-10-02', 'play', 'open_sparring');
      expect(await countHardOrOpenSparringDays(ORG_ID, ATHLETE_ID, DAY)).toBe(4);
      // A window ending earlier leaves out the later days.
      expect(await countHardOrOpenSparringDays(ORG_ID, ATHLETE_ID, '2026-09-30')).toBe(2);
      expect(await countHardOrOpenSparringDays(OTHER_ORG_ID, ATHLETE_ID, DAY)).toBe(1);
      expect(await countHardOrOpenSparringDays(ORG_ID, OTHER_ATHLETE_ID, DAY)).toBe(2);

      await client.query(
        'update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2',
        [ORG_ID, ATHLETE_ID],
      );
      expect(await countHardOrOpenSparringDays(ORG_ID, ATHLETE_ID, DAY)).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('readCapForEntry: none, set, and a refusal is "unknown" -- never "none"', async () => {
    const client = await migratedDatabase('stage_cap');
    try {
      expect(await readCapForEntry(COACH, ATHLETE_ID)).toEqual({ state: 'none', cap: null });

      await client.query(
        `insert into pilot.athlete_contact_caps
           (organization_id, cap_id, athlete_id, highest_allowed_stage, max_hard_open_sessions_per_7_days,
            set_by_account_id, set_by_role)
         values ($1, gen_random_uuid(), $2, 'light_technical', 1, $3, 'coach')`,
        [ORG_ID, ATHLETE_ID, COACH_ID],
      );
      const reading = await readCapForEntry(COACH, ATHLETE_ID);
      expect(reading.state).toBe('set');
      expect(reading.cap?.highest_allowed_stage).toBe('light_technical');

      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await readCapForEntry(UNASSIGNED_COACH, ATHLETE_ID)).toEqual({ state: 'unknown', cap: null });
        // Unknown for the right reason: the cap module refused this coach.
        expect(errorSpy).toHaveBeenCalledWith(expect.objectContaining({ forbidden: true }));
      } finally {
        errorSpy.mockRestore();
      }

      // A cleared cap is "none", not "set".
      await client.query(
        `insert into pilot.athlete_contact_caps
           (organization_id, cap_id, athlete_id, set_by_account_id, set_by_role)
         values ($1, gen_random_uuid(), $2, $3, 'coach')`,
        [ORG_ID, ATHLETE_ID, COACH_ID],
      );
      expect(await readCapForEntry(COACH, ATHLETE_ID)).toEqual({ state: 'none', cap: null });
    } finally {
      await client.end();
    }
  });
});
