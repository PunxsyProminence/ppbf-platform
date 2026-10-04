// Real PostgreSQL-backed test for the athlete-contact-caps migration and for
// athleteContactCaps.ts on top of it. './db' is mocked to route into the
// embedded server (the athleteDevelopmentBlocks.pg.test.ts pattern), so the
// module's real SQL -- and access.ts's -- runs against real rows.
//
// What needs a real database to prove:
//   * the migration creates the table from nothing, re-applies as a no-op,
//     and the runner's readiness check refuses a database it never reached;
//   * the ladder, the 0-14 session range, the note length and the setter's
//     role are DATABASE refusals, and a cap cannot name another gym's athlete;
//   * caps are append-only: the newest row is in force, a clear is a row,
//     and no earlier row is ever changed;
//   * only staff with an ACTIVE membership here, who reach the athlete through
//     assertActorCanAccessAthlete, may read or set -- each near-miss refused;
//   * no cap set reads as null, never as an invented default.
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
import {
  getCurrentContactCap,
  isCapSet,
  listContactCapHistory,
  setContactCap,
} from './athleteContactCaps';
import type { PilotRole } from './contracts';
import { ForbiddenError, ValidationError } from './errors';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-contact-caps-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_contact_caps_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-athlete-contact-caps-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-caps';
const OTHER_ORG_ID = 'org-caps-elsewhere';
const ADMIN_ID = 'acct-caps-admin';
const OTHER_ADMIN_ID = 'acct-caps-other-admin';
const COACH_ID = 'acct-caps-coach'; // coach of record for both athletes here
const LAPSED_COACH_ID = 'acct-caps-lapsed'; // membership here deactivated
const VISITING_COACH_ID = 'acct-caps-visiting'; // home elsewhere, member here, coverage on ATHLETE_ID only
const UNASSIGNED_COACH_ID = 'acct-caps-unassigned'; // active coach here, reaches nobody
const ATHLETE_ACCOUNT_ID = 'acct-caps-athlete';
const PARENT_ACCOUNT_ID = 'acct-caps-parent'; // linked guardian of ATHLETE_ID
const VOLUNTEER_ACCOUNT_ID = 'acct-caps-volunteer';
const ATHLETE_ID = 'ath-caps-1';
const SECOND_ATHLETE_ID = 'ath-caps-2';
const OTHER_ATHLETE_ID = 'ath-caps-other';

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
const PLATFORM_OWNER = actorFor('acct-caps-owner', 'platform_owner');
const BOARD = actorFor('acct-caps-board', 'board');

const LIGHT = { highestAllowedStage: 'light_technical' as const, maxHardOpenSessionsPer7Days: 0, note: '' };

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
            ($9, 'organization_admin', $11, 'microsoft', null)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, VISITING_COACH_ID, UNASSIGNED_COACH_ID,
     ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, VOLUNTEER_ACCOUNT_ID, OTHER_ADMIN_ID,
     ORG_ID, OTHER_ORG_ID, ATHLETE_ID],
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
            ($9, $11, 'organization_admin', true)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, VISITING_COACH_ID, UNASSIGNED_COACH_ID,
     ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, VOLUNTEER_ACCOUNT_ID, OTHER_ADMIN_ID,
     ORG_ID, OTHER_ORG_ID],
  );

  for (const [org, athleteId, coachId] of [
    [ORG_ID, ATHLETE_ID, COACH_ID],
    [ORG_ID, SECOND_ATHLETE_ID, COACH_ID],
    [OTHER_ORG_ID, OTHER_ATHLETE_ID, VISITING_COACH_ID],
  ] as const) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Caps Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [org, athleteId, coachId],
    );
  }

  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, 'parent-caps-1', $2, 'Linked Guardian') on conflict do nothing`,
    [ORG_ID, PARENT_ACCOUNT_ID],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'parent-caps-1', $2, 'parent') on conflict do nothing`,
    [ORG_ID, ATHLETE_ID],
  );
  await client.query(
    `insert into pilot.coach_coverage
       (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
     values ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '8 hours')`,
    [ORG_ID, ATHLETE_ID, VISITING_COACH_ID, ADMIN_ID],
  );

  if (preMigration) {
    await client.query('drop table if exists pilot.athlete_contact_caps cascade');
  }
  return client;
}

async function migratedDatabase(name: string): Promise<Client> {
  const client = await freshDatabase(name);
  activeClient = client;
  return client;
}

function insertRaw(client: Client, overrides: Record<string, unknown> = {}) {
  return client.query(
    `insert into pilot.athlete_contact_caps
       (organization_id, cap_id, athlete_id, highest_allowed_stage,
        max_hard_open_sessions_per_7_days, note, set_by_account_id, set_by_role)
     values ($1, gen_random_uuid(), $2, $3, $4, $5, $6, $7)`,
    [
      overrides.organization_id ?? ORG_ID,
      overrides.athlete_id ?? ATHLETE_ID,
      'highest_allowed_stage' in overrides ? overrides.highest_allowed_stage : 'controlled_sparring',
      'max' in overrides ? overrides.max : 2,
      overrides.note ?? '',
      overrides.set_by_account_id ?? COACH_ID,
      overrides.set_by_role ?? 'coach',
    ],
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

describe('athlete contact caps migration', () => {
  test('creates the table from nothing, and a re-apply leaves rows untouched', async () => {
    const client = await freshDatabase('caps_fresh', { preMigration: true });
    try {
      const before = await client.query(`select to_regclass('pilot.athlete_contact_caps') as t`);
      expect(before.rows[0].t).toBeNull();

      await applyMigrationTransaction(client, migrationSql);
      await insertRaw(client);
      await applyMigrationTransaction(client, migrationSql);

      const { rows } = await client.query(
        `select highest_allowed_stage, max_hard_open_sessions_per_7_days from pilot.athlete_contact_caps`,
      );
      expect(rows).toEqual([{ highest_allowed_stage: 'controlled_sparring', max_hard_open_sessions_per_7_days: 2 }]);
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('caps_not_ready', { preMigration: true });
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /ATHLETE_CONTACT_CAPS_TABLE_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the database refuses an invented stage, an out-of-range count, a long note and a non-staff setter', async () => {
    const client = await freshDatabase('caps_checks');
    try {
      await expect(insertRaw(client, { highest_allowed_stage: 'hard_sparring' })).rejects.toThrow(
        /pilot_athlete_contact_caps_stage_check/,
      );
      await expect(insertRaw(client, { max: 15 })).rejects.toThrow(/pilot_athlete_contact_caps_sessions_check/);
      await expect(insertRaw(client, { max: -1 })).rejects.toThrow(/pilot_athlete_contact_caps_sessions_check/);
      await expect(insertRaw(client, { note: 'x'.repeat(1001) })).rejects.toThrow(
        /pilot_athlete_contact_caps_note_check/,
      );
      await expect(insertRaw(client, { set_by_role: 'athlete' })).rejects.toThrow(
        /pilot_athlete_contact_caps_role_check/,
      );
      // Both limits empty is a legal row: that is how a cap is cleared.
      await expect(insertRaw(client, { highest_allowed_stage: null, max: null })).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });

  test('a cap cannot name another gym\'s athlete', async () => {
    const client = await freshDatabase('caps_fk');
    try {
      await expect(insertRaw(client, { athlete_id: OTHER_ATHLETE_ID })).rejects.toThrow(
        /pilot_athlete_contact_caps_athlete_fk/,
      );
    } finally {
      await client.end();
    }
  });
});

describe('athleteContactCaps.ts against real rows', () => {
  test('no cap set reads as null, never as a default', async () => {
    const client = await migratedDatabase('caps_none');
    try {
      expect(await getCurrentContactCap(COACH, ATHLETE_ID)).toBeNull();
      expect(await listContactCapHistory(COACH, ATHLETE_ID)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('append-only: the newest row is in force, a clear is a row, earlier rows never change', async () => {
    const client = await migratedDatabase('caps_append');
    try {
      const first = await setContactCap({ actor: COACH, athleteId: ATHLETE_ID, ...LIGHT, note: '  first cap  ' });
      expect(first).toMatchObject({
        highest_allowed_stage: 'light_technical',
        max_hard_open_sessions_per_7_days: 0,
        note: 'first cap',
        set_by_account_id: COACH_ID,
        set_by_role: 'coach',
      });

      const second = await setContactCap({
        actor: ADMIN,
        athleteId: ATHLETE_ID,
        highestAllowedStage: 'controlled_sparring',
        maxHardOpenSessionsPer7Days: null,
        note: '',
      });
      expect(second.set_by_role).toBe('organization_admin');
      expect((await getCurrentContactCap(COACH, ATHLETE_ID))?.cap_id).toBe(second.cap_id);

      const cleared = await setContactCap({
        actor: COACH,
        athleteId: ATHLETE_ID,
        highestAllowedStage: null,
        maxHardOpenSessionsPer7Days: null,
        note: '',
      });
      const current = await getCurrentContactCap(COACH, ATHLETE_ID);
      expect(current?.cap_id).toBe(cleared.cap_id);
      expect(isCapSet(current)).toBe(false);

      const history = await listContactCapHistory(COACH, ATHLETE_ID);
      expect(history.map((row) => row.cap_id)).toEqual([cleared.cap_id, second.cap_id, first.cap_id]);
      // The first row reads exactly as it was written.
      expect(history[2]).toEqual(first);

      // A cap on one athlete says nothing about another.
      expect(await getCurrentContactCap(COACH, SECOND_ATHLETE_ID)).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a coach covering an athlete may set and read that athlete\'s cap, and only that one', async () => {
    const client = await migratedDatabase('caps_coverage');
    try {
      const row = await setContactCap({ actor: VISITING_COACH, athleteId: ATHLETE_ID, ...LIGHT });
      expect(row.set_by_role).toBe('coach');
      expect((await getCurrentContactCap(VISITING_COACH, ATHLETE_ID))?.cap_id).toBe(row.cap_id);
      await expect(getCurrentContactCap(VISITING_COACH, SECOND_ATHLETE_ID)).rejects.toBeInstanceOf(ForbiddenError);
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
  ])('%s may neither read nor set a cap', async (_label, actor) => {
    const client = await migratedDatabase(`caps_deny_${actor.accountId.replace(/[^a-z]/g, '_')}`);
    try {
      await insertRaw(client);
      await expect(getCurrentContactCap(actor, ATHLETE_ID)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listContactCapHistory(actor, ATHLETE_ID)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setContactCap({ actor, athleteId: ATHLETE_ID, ...LIGHT })).rejects.toBeInstanceOf(ForbiddenError);
      const { rows } = await client.query('select count(*)::int as n from pilot.athlete_contact_caps');
      expect(rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('a deleted athlete\'s cap is unreachable, even for their coach of record', async () => {
    const client = await migratedDatabase('caps_deleted');
    try {
      await insertRaw(client);
      await client.query(
        'update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2',
        [ORG_ID, ATHLETE_ID],
      );
      await expect(getCurrentContactCap(COACH, ATHLETE_ID)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setContactCap({ actor: ADMIN, athleteId: ATHLETE_ID, ...LIGHT })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    } finally {
      await client.end();
    }
  });

  test('the module refuses bad shapes before touching the database', async () => {
    const client = await migratedDatabase('caps_shape');
    try {
      const base = { actor: COACH, athleteId: ATHLETE_ID, note: '' };
      await expect(
        setContactCap({ ...base, highestAllowedStage: 'sparring' as never, maxHardOpenSessionsPer7Days: null }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        setContactCap({ ...base, highestAllowedStage: null, maxHardOpenSessionsPer7Days: 15 }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        setContactCap({ ...base, highestAllowedStage: null, maxHardOpenSessionsPer7Days: 1.5 }),
      ).rejects.toBeInstanceOf(ValidationError);
      const { rows } = await client.query('select count(*)::int as n from pilot.athlete_contact_caps');
      expect(rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });
});
