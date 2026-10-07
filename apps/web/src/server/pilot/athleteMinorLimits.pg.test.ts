// Real PostgreSQL-backed test for the athlete-minor-limits migration and for
// athleteMinorLimits.ts on top of it. './db' is mocked to route into the
// embedded server (the athleteContactCaps.pg.test.ts pattern; withTransaction
// runs a real BEGIN/COMMIT/ROLLBACK), so the module's real SQL -- and
// access.ts's and audit.ts's -- runs against real rows.
//
// What needs a real database to prove:
//   * the migration creates the table from nothing, re-applies as a no-op,
//     and the runner's readiness check refuses a database it never reached;
//   * the type, unit, value shape per type, note length and setter role are
//     DATABASE refusals, and a limit cannot name another gym's athlete;
//   * limits are append-only, one type at a time: the newest row per type is
//     in force, a clear is a row, and no earlier row is ever changed;
//   * the audit row commits with the limit row, and the limit row rolls back
//     with the audit row;
//   * only staff with an ACTIVE membership here, who reach the athlete through
//     assertActorCanAccessAthlete, may read or set -- each near-miss refused,
//     and one gym never sees another's rows for the same athlete id;
//   * no limit set reads as null, never as an invented default; minor/adult is
//     read from dob at read time.
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
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const client = activeClient;
    await client.query('BEGIN');
    try {
      const result = await fn({ query: (text: string, values: unknown[]) => client.query(text, values) });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }),
}));

import * as accessModule from './access';
import type { ActorIdentity } from './access';
import * as auditModule from './audit';
import {
  getCurrentMinorLimit,
  isLimitSet,
  minorLimitAccessibleAthleteIds,
  readAthleteMinorLimits,
  setMinorLimit,
} from './athleteMinorLimits';
import type { PilotRole } from './contracts';
import { ForbiddenError, ValidationError } from './errors';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-minor-limits-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_minor_limits_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-athlete-minor-limits-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-limits';
const OTHER_ORG_ID = 'org-limits-elsewhere';
const ADMIN_ID = 'acct-limits-admin';
const OTHER_ADMIN_ID = 'acct-limits-other-admin';
const COACH_ID = 'acct-limits-coach'; // coach of record for ATHLETE, SECOND, ADULT, SHARED here
const LAPSED_COACH_ID = 'acct-limits-lapsed'; // membership here deactivated
const VISITING_COACH_ID = 'acct-limits-visiting'; // home elsewhere, member here, coverage on ATHLETE_ID only
const UNASSIGNED_COACH_ID = 'acct-limits-unassigned'; // active coach here, reaches nobody
const ATHLETE_ACCOUNT_ID = 'acct-limits-athlete';
const PARENT_ACCOUNT_ID = 'acct-limits-parent'; // linked guardian of ATHLETE_ID
const VOLUNTEER_ACCOUNT_ID = 'acct-limits-volunteer';
// Home role organization_admin (of the other gym); here, only a COACH
// membership, coach of record for nobody. Reaches nobody here.
const HOME_ADMIN_ID = 'acct-limits-home-admin';
const ATHLETE_ID = 'ath-limits-1'; // born 2012: a minor
const SECOND_ATHLETE_ID = 'ath-limits-2';
const ADULT_ATHLETE_ID = 'ath-limits-adult'; // born 1990
const OTHER_ATHLETE_ID = 'ath-limits-other'; // the other gym's
// The same athlete id in BOTH gyms (pilot.athletes' key is composite).
const SHARED_ATHLETE_ID = 'ath-limits-shared';
// Coach of record: the LAPSED coach. Only the membership check refuses them.
const THIRD_ATHLETE_ID = 'ath-limits-3';

function actorFor(
  accountId: string,
  role: PilotRole,
  organizationId: string = ORG_ID,
  athleteId: string | null = null,
): ActorIdentity {
  return { accountId, role, organizationId, athleteId };
}

const ADMIN = actorFor(ADMIN_ID, 'organization_admin');
const OTHER_ADMIN = actorFor(OTHER_ADMIN_ID, 'organization_admin', OTHER_ORG_ID);
const COACH = actorFor(COACH_ID, 'coach');
const LAPSED_COACH = actorFor(LAPSED_COACH_ID, 'coach');
const VISITING_COACH = actorFor(VISITING_COACH_ID, 'coach');
const UNASSIGNED_COACH = actorFor(UNASSIGNED_COACH_ID, 'coach');
const ATHLETE = actorFor(ATHLETE_ACCOUNT_ID, 'athlete', ORG_ID, ATHLETE_ID);
const GUARDIAN = actorFor(PARENT_ACCOUNT_ID, 'parent');
const VOLUNTEER = actorFor(VOLUNTEER_ACCOUNT_ID, 'volunteer');
// The session carries the HOME role; the gym is this one.
const HOME_ADMIN_AS_COACH_HERE = actorFor(HOME_ADMIN_ID, 'organization_admin');
const PLATFORM_OWNER = actorFor('acct-limits-owner', 'platform_owner');
const BOARD = actorFor('acct-limits-board', 'board');

const HEAT_20 = {
  limitType: 'heat_exposure_minutes_per_session' as const,
  valueNumber: 20,
  valueText: null,
  note: '',
};
const CUT_3 = {
  limitType: 'weight_cut_max_percent_body_weight' as const,
  valueNumber: 3,
  valueText: null,
  note: '',
};
const SUPERVISED = {
  limitType: 'supervision' as const,
  valueNumber: null,
  valueText: 'Coach within arm\'s reach for all pad and bag work',
  note: '',
};

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

/** The full production schema, two gyms, every standing the access rule distinguishes. */
async function freshDatabase(name: string, { preMigration = false } = {}): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }

  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id)
     values ($1, 'organization_admin', $10, 'microsoft', null),
            ($2, 'coach',              $10, 'microsoft', null),
            ($3, 'coach',              $10, 'microsoft', null),
            ($4, 'coach',              $11, 'microsoft', null),
            ($5, 'coach',              $10, 'microsoft', null),
            ($6, 'athlete',            $10, 'microsoft', $12),
            ($7, 'parent',             $10, 'microsoft', null),
            ($8, 'volunteer',          $10, 'microsoft', null),
            ($9, 'organization_admin', $11, 'microsoft', null),
            ($13, 'organization_admin', $11, 'microsoft', null)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, VISITING_COACH_ID, UNASSIGNED_COACH_ID,
     ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, VOLUNTEER_ACCOUNT_ID, OTHER_ADMIN_ID,
     ORG_ID, OTHER_ORG_ID, ATHLETE_ID, HOME_ADMIN_ID],
  );

  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
     values ($1, $10, 'organization_admin', true),
            ($2, $10, 'coach',              true),
            ($3, $10, 'coach',              false),
            ($4, $10, 'coach',              true),
            ($4, $11, 'coach',              true),
            ($5, $10, 'coach',              true),
            ($6, $10, 'athlete',            true),
            ($7, $10, 'parent',             true),
            ($8, $10, 'volunteer',          true),
            ($9, $11, 'organization_admin', true),
            ($12, $11, 'organization_admin', true),
            ($12, $10, 'coach',              true)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, VISITING_COACH_ID, UNASSIGNED_COACH_ID,
     ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, VOLUNTEER_ACCOUNT_ID, OTHER_ADMIN_ID,
     ORG_ID, OTHER_ORG_ID, HOME_ADMIN_ID],
  );

  for (const [org, athleteId, coachId, dob] of [
    [ORG_ID, ATHLETE_ID, COACH_ID, '2012-01-01'],
    [ORG_ID, SECOND_ATHLETE_ID, COACH_ID, '2012-01-01'],
    [ORG_ID, ADULT_ATHLETE_ID, COACH_ID, '1990-01-01'],
    [ORG_ID, SHARED_ATHLETE_ID, COACH_ID, '2012-01-01'],
    [ORG_ID, THIRD_ATHLETE_ID, LAPSED_COACH_ID, '2012-01-01'],
    [OTHER_ORG_ID, OTHER_ATHLETE_ID, VISITING_COACH_ID, '2012-01-01'],
    [OTHER_ORG_ID, SHARED_ATHLETE_ID, VISITING_COACH_ID, '2012-01-01'],
  ] as const) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Limits Athlete', $4, '100', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [org, athleteId, coachId, dob],
    );
  }

  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, 'parent-limits-1', $2, 'Linked Guardian') on conflict do nothing`,
    [ORG_ID, PARENT_ACCOUNT_ID],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'parent-limits-1', $2, 'parent') on conflict do nothing`,
    [ORG_ID, ATHLETE_ID],
  );
  await client.query(
    `insert into pilot.coach_coverage
       (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
     values ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '8 hours')`,
    [ORG_ID, ATHLETE_ID, VISITING_COACH_ID, ADMIN_ID],
  );

  if (preMigration) {
    await client.query('drop table if exists pilot.athlete_minor_limits cascade');
  }
  return client;
}

/** The runner's transaction with no SQL to apply: readiness alone decides. */
function applyMutationFree(client: Client): Promise<void> {
  return applyMigrationTransaction(client, 'select 1');
}

async function migratedDatabase(name: string): Promise<Client> {
  const client = await freshDatabase(name);
  activeClient = client;
  return client;
}

function insertRaw(client: Client, overrides: Record<string, unknown> = {}) {
  return client.query(
    `insert into pilot.athlete_minor_limits
       (organization_id, limit_id, athlete_id, limit_type, value_number, value_text, unit,
        note, set_by_account_id, set_by_role)
     values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      overrides.organization_id ?? ORG_ID,
      overrides.athlete_id ?? ATHLETE_ID,
      overrides.limit_type ?? 'heat_exposure_minutes_per_session',
      'value_number' in overrides ? overrides.value_number : 20,
      'value_text' in overrides ? overrides.value_text : null,
      overrides.unit ?? 'minutes',
      overrides.note ?? '',
      overrides.set_by_account_id ?? COACH_ID,
      overrides.set_by_role ?? 'coach',
    ],
  );
}

async function limitCount(client: Client): Promise<number> {
  const { rows } = await client.query('select count(*)::int as n from pilot.athlete_minor_limits');
  return rows[0].n;
}

async function auditRows(client: Client) {
  const { rows } = await client.query(
    `select event_type, actor_account_id, actor_role, organization_id, entity_id, details
       from pilot.audit_events where entity_type = 'athlete_minor_limit' order by created_at`,
  );
  return rows;
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
  jest.restoreAllMocks();
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

describe('athlete minor limits migration', () => {
  test('creates the table from nothing, and a re-apply leaves rows untouched', async () => {
    const client = await freshDatabase('limits_fresh', { preMigration: true });
    try {
      const before = await client.query(`select to_regclass('pilot.athlete_minor_limits') as t`);
      expect(before.rows[0].t).toBeNull();

      await applyMigrationTransaction(client, migrationSql);
      await insertRaw(client);
      await applyMigrationTransaction(client, migrationSql);

      const { rows } = await client.query(
        `select limit_type, value_number::float8 as value_number, unit from pilot.athlete_minor_limits`,
      );
      expect(rows).toEqual([{ limit_type: 'heat_exposure_minutes_per_session', value_number: 20, unit: 'minutes' }]);
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('limits_not_ready', { preMigration: true });
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /ATHLETE_MINOR_LIMITS_TABLE_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test.each([
    ['the shape check dropped', 'alter table pilot.athlete_minor_limits drop constraint pilot_athlete_minor_limits_shape_check'],
    // Same words, looser predicate: the exact-text comparison is what refuses it.
    ['the shape check loosened', `alter table pilot.athlete_minor_limits drop constraint pilot_athlete_minor_limits_shape_check,
       add constraint pilot_athlete_minor_limits_shape_check check (
         (limit_type = 'heat_exposure_minutes_per_session' and unit = 'minutes' and value_text is null)
         or (limit_type = 'weight_cut_max_percent_body_weight' and unit = 'percent_body_weight' and value_text is null
             and (value_number is null or value_number <= 100))
         or (limit_type = 'supervision' and unit = 'text' and value_number is null)
         or (unit = 'text'))`],
    // Same words, no upper bound: NaN and Infinity would pass.
    ['the number check loosened', `alter table pilot.athlete_minor_limits drop constraint pilot_athlete_minor_limits_number_check,
       add constraint pilot_athlete_minor_limits_number_check check (value_number is null or value_number >= 0)`],
    ['the read index dropped', 'drop index pilot.idx_athlete_minor_limits_athlete_type_seq'],
    ['the athlete foreign key dropped', 'alter table pilot.athlete_minor_limits drop constraint pilot_athlete_minor_limits_athlete_fk'],
    ['the athlete foreign key without cascade', `alter table pilot.athlete_minor_limits drop constraint pilot_athlete_minor_limits_athlete_fk,
       add constraint pilot_athlete_minor_limits_athlete_fk foreign key (organization_id, athlete_id)
       references pilot.athletes(organization_id, athlete_id)`],
  ])('the runner refuses a table with %s, with everything else right', async (label, breakIt) => {
    const client = await freshDatabase(`limits_short_${label.replace(/[^a-z]+/g, '_')}`);
    try {
      await client.query(breakIt);
      await expect(applyMutationFree(client)).rejects.toThrow(/ATHLETE_MINOR_LIMITS_TABLE_NOT_READY/);
    } finally {
      await client.end();
    }
  });

  test('the database refuses an invented type, a wrong unit, the wrong kind of value, a negative, NaN or infinite number, a percentage over 100, blank or long text, a long note and a non-staff setter', async () => {
    const client = await freshDatabase('limits_checks');
    try {
      // contact_level is not a type here on purpose (it lives in athlete_contact_caps).
      // Two guards refuse these rows (the vocabulary check and the per-type
      // shape check); Postgres names whichever it evaluates first.
      await expect(insertRaw(client, { limit_type: 'contact_level' })).rejects.toThrow(
        /pilot_athlete_minor_limits_(type|shape)_check/,
      );
      await expect(insertRaw(client, { unit: 'hours' })).rejects.toThrow(
        /pilot_athlete_minor_limits_(unit|shape)_check/,
      );
      // Heat in percent, or text on a numeric type, or a number on supervision.
      await expect(insertRaw(client, { unit: 'percent_body_weight' })).rejects.toThrow(
        /pilot_athlete_minor_limits_shape_check/,
      );
      await expect(insertRaw(client, { value_text: 'twenty' })).rejects.toThrow(
        /pilot_athlete_minor_limits_shape_check/,
      );
      await expect(insertRaw(client, { limit_type: 'supervision', unit: 'text', value_number: 1, value_text: 'x' }))
        .rejects.toThrow(/pilot_athlete_minor_limits_shape_check/);
      await expect(insertRaw(client, { value_number: -1 })).rejects.toThrow(/pilot_athlete_minor_limits_number_check/);
      await expect(
        insertRaw(client, { limit_type: 'weight_cut_max_percent_body_weight', unit: 'percent_body_weight', value_number: 100.5 }),
      ).rejects.toThrow(/pilot_athlete_minor_limits_shape_check/);
      await expect(
        insertRaw(client, { limit_type: 'supervision', unit: 'text', value_number: null, value_text: '   ' }),
      ).rejects.toThrow(/pilot_athlete_minor_limits_text_check/);
      // Tabs and line breaks alone are blank too (btrim's default strips spaces only).
      await expect(
        insertRaw(client, { limit_type: 'supervision', unit: 'text', value_number: null, value_text: '\t\n \r' }),
      ).rejects.toThrow(/pilot_athlete_minor_limits_text_check/);
      // NaN and Infinity are numerics that sort above every number; the
      // closed upper bound refuses both (the module never sends either).
      // OBSERVED: numeric(8,2)'s own typmod refuses Infinity first ("numeric
      // field overflow"), so either refusal is the row being refused.
      await expect(insertRaw(client, { value_number: 'NaN' })).rejects.toThrow(/pilot_athlete_minor_limits_number_check/);
      await expect(insertRaw(client, { value_number: 'Infinity' })).rejects.toThrow(/numeric field overflow|pilot_athlete_minor_limits_number_check/);
      await expect(insertRaw(client, { value_number: 1000000 })).rejects.toThrow(/numeric field overflow|pilot_athlete_minor_limits_number_check/);
      await expect(
        insertRaw(client, { limit_type: 'supervision', unit: 'text', value_number: null, value_text: 'x'.repeat(501) }),
      ).rejects.toThrow(/pilot_athlete_minor_limits_text_check/);
      await expect(insertRaw(client, { note: 'x'.repeat(1001) })).rejects.toThrow(
        /pilot_athlete_minor_limits_note_check/,
      );
      await expect(insertRaw(client, { set_by_role: 'athlete' })).rejects.toThrow(
        /pilot_athlete_minor_limits_role_check/,
      );
      // No app-set ceiling on minutes: a high number a coach chooses is stored as typed.
      await expect(insertRaw(client, { value_number: 240 })).resolves.toBeDefined();
      // 100% is a legal percentage; a cleared row (null value) is legal for every type.
      await expect(
        insertRaw(client, { limit_type: 'weight_cut_max_percent_body_weight', unit: 'percent_body_weight', value_number: 100 }),
      ).resolves.toBeDefined();
      await expect(insertRaw(client, { value_number: null })).resolves.toBeDefined();
      await expect(
        insertRaw(client, { limit_type: 'supervision', unit: 'text', value_number: null, value_text: null }),
      ).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });

  test('a limit cannot name another gym\'s athlete, and goes with the athlete when the athlete is purged', async () => {
    const client = await freshDatabase('limits_fk');
    try {
      await expect(insertRaw(client, { athlete_id: OTHER_ATHLETE_ID })).rejects.toThrow(
        /pilot_athlete_minor_limits_athlete_fk/,
      );
      await insertRaw(client, { athlete_id: SECOND_ATHLETE_ID });
      await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG_ID, SECOND_ATHLETE_ID]);
      expect(await limitCount(client)).toBe(0);
    } finally {
      await client.end();
    }
  });
});

describe('athleteMinorLimits.ts against real rows', () => {
  test('no limit set reads as null for every type, never as a default; a 2012 birth is a minor, a 1990 birth is not', async () => {
    const client = await migratedDatabase('limits_none');
    try {
      const reading = await readAthleteMinorLimits(COACH, ATHLETE_ID);
      expect(reading).toEqual({
        athlete_is_minor: true,
        limits: {
          heat_exposure_minutes_per_session: null,
          weight_cut_max_percent_body_weight: null,
          supervision: null,
        },
        history: [],
      });
      expect(await getCurrentMinorLimit(COACH, ATHLETE_ID, 'supervision')).toBeNull();
      expect((await readAthleteMinorLimits(COACH, ADULT_ATHLETE_ID)).athlete_is_minor).toBe(false);
    } finally {
      await client.end();
    }
  });

  test('append-only, one type at a time: the newest row per type is in force, a clear is a row, earlier rows never change', async () => {
    const client = await migratedDatabase('limits_append');
    try {
      const heat = await setMinorLimit({ actor: COACH, athleteId: ATHLETE_ID, ...HEAT_20, note: '  summer  ' });
      expect(heat).toMatchObject({
        limit_type: 'heat_exposure_minutes_per_session',
        value_number: 20,
        value_text: null,
        unit: 'minutes',
        note: 'summer',
        set_by_account_id: COACH_ID,
        set_by_role: 'coach',
      });
      const cut = await setMinorLimit({ actor: ADMIN, athleteId: ATHLETE_ID, ...CUT_3, valueNumber: 2.5 });
      expect(cut).toMatchObject({ value_number: 2.5, unit: 'percent_body_weight', set_by_role: 'organization_admin' });
      const supervised = await setMinorLimit({ actor: COACH, athleteId: ATHLETE_ID, ...SUPERVISED });
      expect(supervised).toMatchObject({ value_text: SUPERVISED.valueText, value_number: null, unit: 'text' });

      // Changing one type leaves the other two in force.
      const heat2 = await setMinorLimit({ actor: COACH, athleteId: ATHLETE_ID, ...HEAT_20, valueNumber: 15 });
      let reading = await readAthleteMinorLimits(COACH, ATHLETE_ID);
      expect(reading.limits.heat_exposure_minutes_per_session?.limit_id).toBe(heat2.limit_id);
      expect(reading.limits.weight_cut_max_percent_body_weight?.limit_id).toBe(cut.limit_id);
      expect(reading.limits.supervision?.limit_id).toBe(supervised.limit_id);

      // Clearing one type is a row; it reads as null while the others stand.
      const cleared = await setMinorLimit({ actor: COACH, athleteId: ATHLETE_ID, ...HEAT_20, valueNumber: null });
      expect(isLimitSet(cleared)).toBe(false);
      reading = await readAthleteMinorLimits(COACH, ATHLETE_ID);
      expect(reading.limits.heat_exposure_minutes_per_session).toBeNull();
      expect(reading.limits.weight_cut_max_percent_body_weight?.value_number).toBe(2.5);
      expect(reading.limits.supervision?.value_text).toBe(SUPERVISED.valueText);
      expect((await getCurrentMinorLimit(COACH, ATHLETE_ID, 'heat_exposure_minutes_per_session'))?.limit_id).toBe(cleared.limit_id);

      // History is every write, newest first; the first row reads exactly as written.
      expect(reading.history.map((row) => row.limit_id)).toEqual(
        [cleared.limit_id, heat2.limit_id, supervised.limit_id, cut.limit_id, heat.limit_id],
      );
      expect(reading.history[4]).toEqual(heat);
      expect(await limitCount(client)).toBe(5);

      // A limit on one athlete says nothing about another.
      expect((await readAthleteMinorLimits(COACH, SECOND_ATHLETE_ID)).history).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('two writes with the same timestamp: the one written last is in force', async () => {
    const client = await migratedDatabase('limits_tie');
    try {
      for (const value of [30, 10]) {
        await client.query(
          `insert into pilot.athlete_minor_limits
             (organization_id, limit_id, athlete_id, limit_type, value_number, unit, set_by_account_id, set_by_role, set_at)
           values ($1, gen_random_uuid(), $2, 'heat_exposure_minutes_per_session', $3, 'minutes', $4, 'coach', '2026-10-07T12:00:00Z')`,
          [ORG_ID, ATHLETE_ID, value, COACH_ID],
        );
      }
      expect((await getCurrentMinorLimit(COACH, ATHLETE_ID, 'heat_exposure_minutes_per_session'))?.value_number).toBe(10);
      const reading = await readAthleteMinorLimits(COACH, ATHLETE_ID);
      expect(reading.limits.heat_exposure_minutes_per_session?.value_number).toBe(10);
      expect(reading.history.map((row) => row.value_number)).toEqual([10, 30]);
    } finally {
      await client.end();
    }
  });

  test('every write leaves an audit row in the same transaction, naming the type and not the value', async () => {
    const client = await migratedDatabase('limits_audit');
    try {
      const heat = await setMinorLimit({ actor: COACH, athleteId: ATHLETE_ID, ...HEAT_20 });
      const cleared = await setMinorLimit({ actor: ADMIN, athleteId: ATHLETE_ID, ...SUPERVISED, valueText: null });
      const rows = await auditRows(client);
      expect(rows).toEqual([
        {
          event_type: 'create',
          actor_account_id: COACH_ID,
          actor_role: 'coach',
          organization_id: ORG_ID,
          entity_id: heat.limit_id,
          details: { athlete_id: ATHLETE_ID, limit_type: 'heat_exposure_minutes_per_session', cleared: false },
        },
        {
          event_type: 'create',
          actor_account_id: ADMIN_ID,
          actor_role: 'organization_admin',
          organization_id: ORG_ID,
          entity_id: cleared.limit_id,
          details: { athlete_id: ATHLETE_ID, limit_type: 'supervision', cleared: true },
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain('"20"');
    } finally {
      await client.end();
    }
  });

  test('when the audit row cannot be written, the limit row is rolled back with it', async () => {
    const client = await migratedDatabase('limits_audit_rollback');
    jest.spyOn(auditModule, 'writePilotAuditEvent').mockRejectedValueOnce(new Error('audit insert failed'));
    try {
      await expect(setMinorLimit({ actor: COACH, athleteId: ATHLETE_ID, ...HEAT_20 })).rejects.toThrow('audit insert failed');
      expect(await limitCount(client)).toBe(0);
      expect(await auditRows(client)).toEqual([]);
      // The connection is usable afterwards: the transaction was rolled back, not left open.
      const after = await setMinorLimit({ actor: COACH, athleteId: ATHLETE_ID, ...HEAT_20 });
      expect(after.value_number).toBe(20);
      expect(await auditRows(client)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('one gym never sees another gym\'s rows for the same athlete id', async () => {
    const client = await migratedDatabase('limits_isolation');
    try {
      // This gym's row FIRST, the other gym's SECOND: the newest row across
      // both gyms belongs to the other gym, so a read that forgot the
      // organization would answer 99 here. (With the order reversed the
      // newest row happened to be the right one, and a mutant that dropped
      // the organization predicate from the in-force read stayed green.)
      await insertRaw(client, { organization_id: ORG_ID, athlete_id: SHARED_ATHLETE_ID, value_number: 20 });
      await insertRaw(client, { organization_id: OTHER_ORG_ID, athlete_id: SHARED_ATHLETE_ID, set_by_account_id: VISITING_COACH_ID, value_number: 99 });

      const here = await readAthleteMinorLimits(ADMIN, SHARED_ATHLETE_ID);
      expect(here.history.map((row) => row.value_number)).toEqual([20]);
      expect(here.limits.heat_exposure_minutes_per_session?.value_number).toBe(20);
      expect((await getCurrentMinorLimit(COACH, SHARED_ATHLETE_ID, 'heat_exposure_minutes_per_session'))?.value_number).toBe(20);

      const there = await readAthleteMinorLimits(OTHER_ADMIN, SHARED_ATHLETE_ID);
      expect(there.history.map((row) => row.value_number)).toEqual([99]);
      expect(there.limits.heat_exposure_minutes_per_session?.value_number).toBe(99);

      // Writing here lands here only -- and the other gym's reads do not move.
      await setMinorLimit({ actor: COACH, athleteId: SHARED_ATHLETE_ID, ...HEAT_20, valueNumber: 25 });
      const { rows } = await client.query(
        `select organization_id, value_number::float8 as v from pilot.athlete_minor_limits order by limit_seq`,
      );
      expect(rows).toEqual([
        { organization_id: ORG_ID, v: 20 },
        { organization_id: OTHER_ORG_ID, v: 99 },
        { organization_id: ORG_ID, v: 25 },
      ]);
      expect((await readAthleteMinorLimits(ADMIN, SHARED_ATHLETE_ID)).limits.heat_exposure_minutes_per_session?.value_number).toBe(25);
      const thereAfter = await readAthleteMinorLimits(OTHER_ADMIN, SHARED_ATHLETE_ID);
      expect(thereAfter.limits.heat_exposure_minutes_per_session?.value_number).toBe(99);
      expect((await getCurrentMinorLimit(OTHER_ADMIN, SHARED_ATHLETE_ID, 'heat_exposure_minutes_per_session'))?.value_number).toBe(99);
    } finally {
      await client.end();
    }
  });

  test('a coach covering an athlete may set and read that athlete\'s limits, and only that one', async () => {
    const client = await migratedDatabase('limits_coverage');
    try {
      const row = await setMinorLimit({ actor: VISITING_COACH, athleteId: ATHLETE_ID, ...SUPERVISED });
      expect(row.set_by_role).toBe('coach');
      expect((await readAthleteMinorLimits(VISITING_COACH, ATHLETE_ID)).limits.supervision?.limit_id).toBe(row.limit_id);
      await expect(readAthleteMinorLimits(VISITING_COACH, SECOND_ATHLETE_ID)).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['an unassigned coach of the same gym', UNASSIGNED_COACH],
    ['a coach whose membership here lapsed', LAPSED_COACH],
    ['an admin of another gym', OTHER_ADMIN],
    ['the athlete themselves', ATHLETE],
    ['their linked guardian', GUARDIAN],
    ['a volunteer', VOLUNTEER],
    ['the platform owner', PLATFORM_OWNER],
    ['the board', BOARD],
  ])('%s may neither read nor set a limit', async (_label, actor) => {
    const client = await migratedDatabase(`limits_deny_${actor.accountId.replace(/[^a-z]/g, '_')}`);
    try {
      await insertRaw(client);
      await expect(readAthleteMinorLimits(actor, ATHLETE_ID)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getCurrentMinorLimit(actor, ATHLETE_ID, 'heat_exposure_minutes_per_session')).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setMinorLimit({ actor, athleteId: ATHLETE_ID, ...HEAT_20 })).rejects.toBeInstanceOf(ForbiddenError);
      expect(await limitCount(client)).toBe(1);
      expect(await auditRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('a coach of record whose membership here lapsed is refused -- the membership check alone does this', async () => {
    const client = await migratedDatabase('limits_lapsed_of_record');
    try {
      await insertRaw(client, { athlete_id: THIRD_ATHLETE_ID });
      await expect(readAthleteMinorLimits(LAPSED_COACH, THIRD_ATHLETE_ID)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        setMinorLimit({ actor: LAPSED_COACH, athleteId: THIRD_ATHLETE_ID, ...HEAT_20 }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      // The athlete is reachable for the gym's admin, so the refusal above is
      // the lapsed membership and not a missing athlete.
      expect((await readAthleteMinorLimits(ADMIN, THIRD_ATHLETE_ID)).history).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test("an admin elsewhere who is only a coach here reaches only a coach's athletes here", async () => {
    const client = await migratedDatabase('limits_home_role');
    try {
      await insertRaw(client);
      // The session says organization_admin; the membership here says coach,
      // and this account coaches nobody here. Whole-gym admin reach would
      // have let this through.
      await expect(readAthleteMinorLimits(HOME_ADMIN_AS_COACH_HERE, ATHLETE_ID)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(
        setMinorLimit({ actor: HOME_ADMIN_AS_COACH_HERE, athleteId: ATHLETE_ID, ...HEAT_20 }),
      ).rejects.toBeInstanceOf(ForbiddenError);

      // Given coverage of that athlete, it may set -- and is recorded as the
      // coach it is here, not as the admin its home role says.
      await client.query(
        `insert into pilot.coach_coverage
           (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
         values ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '8 hours')`,
        [ORG_ID, ATHLETE_ID, HOME_ADMIN_ID, ADMIN_ID],
      );
      const row = await setMinorLimit({ actor: HOME_ADMIN_AS_COACH_HERE, athleteId: ATHLETE_ID, ...HEAT_20 });
      expect(row.set_by_role).toBe('coach');
      expect((await auditRows(client)).at(-1)).toMatchObject({ actor_role: 'coach', actor_account_id: HOME_ADMIN_ID });
    } finally {
      await client.end();
    }
  });

  test('an outage while checking access is an error, never "not permitted"', async () => {
    const client = await migratedDatabase('limits_outage');
    jest
      .spyOn(accessModule, 'assertActorCanAccessAthlete')
      .mockRejectedValueOnce(new Error('connection terminated unexpectedly'));
    try {
      const attempt = readAthleteMinorLimits(COACH, ATHLETE_ID);
      await expect(attempt).rejects.toThrow('connection terminated unexpectedly');
      await expect(attempt).rejects.not.toBeInstanceOf(ForbiddenError);
    } finally {
      await client.end();
    }
  });

  test('a deleted athlete\'s limits are unreachable, even for their coach of record', async () => {
    const client = await migratedDatabase('limits_deleted');
    try {
      await insertRaw(client);
      await client.query(
        'update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2',
        [ORG_ID, ATHLETE_ID],
      );
      await expect(readAthleteMinorLimits(COACH, ATHLETE_ID)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setMinorLimit({ actor: ADMIN, athleteId: ATHLETE_ID, ...HEAT_20 })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    } finally {
      await client.end();
    }
  });

  test('the roster filter admits exactly whom the limit gate admits', async () => {
    const client = await migratedDatabase('limits_roster');
    try {
      const all = [ATHLETE_ID, SECOND_ATHLETE_ID, ADULT_ATHLETE_ID, SHARED_ATHLETE_ID, THIRD_ATHLETE_ID, OTHER_ATHLETE_ID];
      const sorted = async (actor: ActorIdentity) => [...(await minorLimitAccessibleAthleteIds(actor, all))].sort();
      expect(await sorted(COACH)).toEqual([ATHLETE_ID, SECOND_ATHLETE_ID, ADULT_ATHLETE_ID, SHARED_ATHLETE_ID].sort());
      expect(await sorted(VISITING_COACH)).toEqual([ATHLETE_ID]);
      expect(await sorted(ADMIN)).toEqual(
        [ATHLETE_ID, SECOND_ATHLETE_ID, ADULT_ATHLETE_ID, SHARED_ATHLETE_ID, THIRD_ATHLETE_ID].sort(),
      );
      expect(await sorted(LAPSED_COACH)).toEqual([]);
      expect(await sorted(HOME_ADMIN_AS_COACH_HERE)).toEqual([]);
      for (const actor of [UNASSIGNED_COACH, ATHLETE, GUARDIAN, VOLUNTEER, PLATFORM_OWNER, BOARD]) {
        expect({ who: actor.accountId, ids: await sorted(actor) }).toEqual({ who: actor.accountId, ids: [] });
      }
      // Another gym's admin reaches their own gym's athletes (the shared id included) and none of this gym's.
      expect(await sorted(OTHER_ADMIN)).toEqual([OTHER_ATHLETE_ID, SHARED_ATHLETE_ID].sort());

      // And the filter IS the gate: for every actor and athlete, "in the set"
      // equals "the per-athlete read is not refused".
      const actors = [ADMIN, OTHER_ADMIN, COACH, LAPSED_COACH, VISITING_COACH, UNASSIGNED_COACH,
        HOME_ADMIN_AS_COACH_HERE, ATHLETE, GUARDIAN, VOLUNTEER, PLATFORM_OWNER, BOARD];
      for (const actor of actors) {
        const admitted = await minorLimitAccessibleAthleteIds(actor, all);
        for (const athleteId of all) {
          const gateAdmits = await readAthleteMinorLimits(actor, athleteId).then(() => true, () => false);
          expect({ who: actor.accountId, athleteId, inSet: admitted.has(athleteId) })
            .toEqual({ who: actor.accountId, athleteId, inSet: gateAdmits });
        }
      }
    } finally {
      await client.end();
    }
  });

  test('the module refuses bad shapes before touching the database', async () => {
    const client = await migratedDatabase('limits_shape');
    try {
      const base = { actor: COACH, athleteId: ATHLETE_ID, note: '' };
      await expect(
        setMinorLimit({ ...base, limitType: 'contact_level' as never, valueNumber: 1, valueText: null }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        setMinorLimit({ ...base, ...HEAT_20, valueNumber: -1 }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        setMinorLimit({ ...base, ...CUT_3, valueNumber: 100.01 }),
      ).rejects.toBeInstanceOf(ValidationError);
      // A third decimal place would be rounded by the column (2.555 -> 2.56),
      // a number the coach never typed; refused before the database sees it.
      await expect(
        setMinorLimit({ ...base, ...CUT_3, valueNumber: 2.555 }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        setMinorLimit({ ...base, ...HEAT_20, valueNumber: 0.004 }),
      ).rejects.toBeInstanceOf(ValidationError);
      // Padded supervision text is measured after trimming.
      await expect(
        setMinorLimit({ ...base, ...SUPERVISED, valueText: `  ${'y'.repeat(500)}  ` }),
      ).resolves.toMatchObject({ value_text: 'y'.repeat(500) });
      await expect(
        setMinorLimit({ ...base, ...SUPERVISED, valueText: '   ' }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        setMinorLimit({ ...base, ...SUPERVISED, valueText: 'x'.repeat(501) }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        setMinorLimit({ ...base, ...HEAT_20, note: 'x'.repeat(1001) }),
      ).rejects.toBeInstanceOf(ValidationError);
      expect(await limitCount(client)).toBe(1);
      expect(await auditRows(client)).toHaveLength(1);
    } finally {
      await client.end();
    }
  });

  test('the audit row is not mirrored into the SHADOW event stream or telemetry', async () => {
    // /api/pilot/shadow/events admits athletes and guardians and ties rows to
    // the athlete through details.athlete_id; whether the family sees a
    // child's limits is undecided, so the audit row stays in the audit table.
    const client = await migratedDatabase('limits_no_mirror');
    try {
      await setMinorLimit({ actor: COACH, athleteId: ATHLETE_ID, ...HEAT_20 });
      expect(await auditRows(client)).toHaveLength(1);
      const events = await client.query(
        "select count(*)::int as n from pilot.shadow_events where entity_type = 'athlete_minor_limit' or event_name like '%MINOR_LIMIT%'",
      );
      expect(events.rows[0].n).toBe(0);
      const telemetry = await client.query(
        "select count(*)::int as n from pilot.shadow_telemetry_events where dimensions->>'entity_type' = 'athlete_minor_limit'",
      );
      expect(telemetry.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });
});
