// Real PostgreSQL-backed test for the athlete-rest-marks migration and for
// restMarks.ts on top of it (lane R6-b1, OD-2026-11-17-004). './db' is mocked
// to route into the embedded server (the athleteCapacityNotes.pg.test.ts
// pattern; withTransaction runs a real BEGIN/COMMIT/ROLLBACK), so the module's
// real SQL -- and access.ts's and audit.ts's -- runs against real rows.
//
// What needs a real database to prove:
//   * the migration creates the table from nothing and re-applies as a no-op;
//     the runner refuses a database it never reached, one with a guard
//     dropped or loosened, and one where a reason/note column was added;
//   * an unknown kind, a non-staff marker, a backwards or over-long range and
//     a half-recorded clear are DATABASE refusals; a mark cannot name another
//     gym's athlete and goes with the athlete;
//   * one tap twice is one mark; undo keeps the row; a second undo is not found;
//   * every write is audited in the same transaction with no reason in it;
//   * only staff with an ACTIVE membership here who reach the athlete may
//     mark, clear or read -- each near-miss refused, one gym never sees
//     another's marks for the same athlete id.
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

import type { ActorIdentity } from './access';
import * as auditModule from './audit';
import { addRestMark, clearRestMark, listRestMarks } from './restMarks';
import type { PilotRole } from './contracts';
import { ForbiddenError, NotFoundError, ValidationError } from './errors';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-rest-marks-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_athlete_rest_marks_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-athlete-rest-marks-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-restmarks';
const OTHER_ORG_ID = 'org-restmarks-elsewhere';
const ADMIN_ID = 'acct-restmarks-admin';
const OTHER_ADMIN_ID = 'acct-restmarks-other-admin';
const COACH_ID = 'acct-restmarks-coach'; // coach of record for ATHLETE, SECOND, SHARED here
const LAPSED_COACH_ID = 'acct-restmarks-lapsed'; // membership here deactivated
const VISITING_COACH_ID = 'acct-restmarks-visiting'; // home elsewhere, member here, coverage on ATHLETE_ID only
const UNASSIGNED_COACH_ID = 'acct-restmarks-unassigned'; // active coach here, coach of record for nobody (reaches the whole gym, issue #1480)
const ATHLETE_ACCOUNT_ID = 'acct-restmarks-athlete';
const PARENT_ACCOUNT_ID = 'acct-restmarks-parent'; // linked guardian of ATHLETE_ID
const VOLUNTEER_ACCOUNT_ID = 'acct-restmarks-volunteer';
const ATHLETE_ID = 'ath-restmarks-1';
const SECOND_ATHLETE_ID = 'ath-restmarks-2';
const OTHER_ATHLETE_ID = 'ath-restmarks-other'; // the other gym's
// The same athlete id in BOTH gyms (pilot.athletes' key is composite).
const SHARED_ATHLETE_ID = 'ath-restmarks-shared';
// Coach of record: the LAPSED coach. Only the membership check refuses them.
const THIRD_ATHLETE_ID = 'ath-restmarks-3';

// login_email, from which getStaffAuthorName derives the name shown.
const COACH_EMAIL = 'coach-one@example.org';
const ADMIN_EMAIL = 'gym-admin@example.org';

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
// The visiting coach signed in at their OTHER gym: a coach of another gym.
const VISITING_COACH_AT_HOME = actorFor(VISITING_COACH_ID, 'coach', OTHER_ORG_ID);
const ATHLETE = actorFor(ATHLETE_ACCOUNT_ID, 'athlete', ORG_ID, ATHLETE_ID);
const GUARDIAN = actorFor(PARENT_ACCOUNT_ID, 'parent');
const VOLUNTEER = actorFor(VOLUNTEER_ACCOUNT_ID, 'volunteer');
const PLATFORM_OWNER = actorFor('acct-restmarks-owner', 'platform_owner');
const BOARD = actorFor('acct-restmarks-board', 'board');

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
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id, login_email)
     values ($1, 'organization_admin', $10, 'microsoft', null, $13),
            ($2, 'coach',              $10, 'microsoft', null, $12),
            ($3, 'coach',              $10, 'microsoft', null, null),
            ($4, 'coach',              $11, 'microsoft', null, null),
            ($5, 'coach',              $10, 'microsoft', null, null),
            ($6, 'athlete',            $10, 'microsoft', $14, null),
            ($7, 'parent',             $10, 'microsoft', null, null),
            ($8, 'volunteer',          $10, 'microsoft', null, null),
            ($9, 'organization_admin', $11, 'microsoft', null, null)
     on conflict do nothing`,
    [ADMIN_ID, COACH_ID, LAPSED_COACH_ID, VISITING_COACH_ID, UNASSIGNED_COACH_ID,
     ATHLETE_ACCOUNT_ID, PARENT_ACCOUNT_ID, VOLUNTEER_ACCOUNT_ID, OTHER_ADMIN_ID,
     ORG_ID, OTHER_ORG_ID, COACH_EMAIL, ADMIN_EMAIL, ATHLETE_ID],
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
    [ORG_ID, SHARED_ATHLETE_ID, COACH_ID],
    [ORG_ID, THIRD_ATHLETE_ID, LAPSED_COACH_ID],
    [OTHER_ORG_ID, OTHER_ATHLETE_ID, VISITING_COACH_ID],
    [OTHER_ORG_ID, SHARED_ATHLETE_ID, VISITING_COACH_ID],
  ] as const) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Rest Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [org, athleteId, coachId],
    );
  }

  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name)
     values ($1, 'parent-restmarks-1', $2, 'Linked Guardian') on conflict do nothing`,
    [ORG_ID, PARENT_ACCOUNT_ID],
  );
  await client.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'parent-restmarks-1', $2, 'parent') on conflict do nothing`,
    [ORG_ID, ATHLETE_ID],
  );
  await client.query(
    `insert into pilot.coach_coverage
       (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
     values ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '8 hours')`,
    [ORG_ID, ATHLETE_ID, VISITING_COACH_ID, ADMIN_ID],
  );

  if (preMigration) {
    await client.query('drop table if exists pilot.athlete_rest_marks cascade');
  } else {
    // Idempotent: a no-op once the workflow's `all` list carries it.
    await applyMigrationTransaction(client, migrationSql);
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
    `insert into pilot.athlete_rest_marks
       (organization_id, mark_id, athlete_id, kind, first_day, last_day, marked_by_account_id, marked_by_role,
        cleared_at, cleared_by_account_id)
     values ($1, gen_random_uuid(), $2, $3, $4::date, $5::date, $6, $7, $8, $9)`,
    [
      overrides.organization_id ?? ORG_ID,
      overrides.athlete_id ?? ATHLETE_ID,
      overrides.kind ?? 'rest',
      overrides.first_day ?? '2026-11-13',
      overrides.last_day ?? '2026-11-19',
      overrides.marked_by_account_id ?? COACH_ID,
      overrides.marked_by_role ?? 'coach',
      overrides.cleared_at ?? null,
      overrides.cleared_by_account_id ?? null,
    ],
  );
}

async function markCount(client: Client, { live = false } = {}): Promise<number> {
  const { rows } = await client.query(
    `select count(*)::int as n from pilot.athlete_rest_marks ${live ? 'where cleared_at is null' : ''}`,
  );
  return rows[0].n;
}

async function auditRows(client: Client) {
  const { rows } = await client.query(
    `select event_type, actor_account_id, actor_role, organization_id, entity_id, details
       from pilot.audit_events where entity_type = 'athlete_rest_mark' order by created_at`,
  );
  return rows;
}

const TODAY = '2026-11-19';
const THIS_WEEK = { firstDay: '2026-11-13', lastDay: TODAY };

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


describe('athlete rest marks migration', () => {
  test('creates the table from nothing, and a re-apply leaves rows untouched', async () => {
    const client = await freshDatabase('restmarks_fresh', { preMigration: true });
    try {
      const before = await client.query(`select to_regclass('pilot.athlete_rest_marks') as t`);
      expect(before.rows[0].t).toBeNull();

      await applyMigrationTransaction(client, migrationSql);
      await insertRaw(client);
      await applyMigrationTransaction(client, migrationSql);

      const { rows } = await client.query(
        `select kind, first_day::text as first_day, last_day::text as last_day, cleared_at from pilot.athlete_rest_marks`,
      );
      expect(rows).toEqual([{ kind: 'rest', first_day: '2026-11-13', last_day: '2026-11-19', cleared_at: null }]);
    } finally {
      await client.end();
    }
  });

  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('restmarks_not_ready', { preMigration: true });
    try {
      await expect(applyMutationFree(client)).rejects.toThrow(/ATHLETE_REST_MARKS_TABLE_NOT_READY/);
    } finally {
      await client.end();
    }
  });

  test.each([
    // The privacy guarantee lives in the column list: a reason column is refused.
    ['a reason column added', 'alter table pilot.athlete_rest_marks add column reason text null'],
    ['a note column added', 'alter table pilot.athlete_rest_marks add column note text null'],
    ['the kind check loosened', `alter table pilot.athlete_rest_marks drop constraint pilot_athlete_rest_marks_kind_check,
       add constraint pilot_athlete_rest_marks_kind_check check (kind in ('rest', 'away', 'sick'))`],
    ['the role check loosened', `alter table pilot.athlete_rest_marks drop constraint pilot_athlete_rest_marks_role_check,
       add constraint pilot_athlete_rest_marks_role_check check (marked_by_role in ('coach', 'organization_admin', 'admin', 'athlete'))`],
    ['the range check dropped', 'alter table pilot.athlete_rest_marks drop constraint pilot_athlete_rest_marks_range_check'],
    ['the range check loosened', `alter table pilot.athlete_rest_marks drop constraint pilot_athlete_rest_marks_range_check,
       add constraint pilot_athlete_rest_marks_range_check check ((last_day >= first_day) and ((last_day - first_day) <= 364))`],
    ['the clear check dropped', 'alter table pilot.athlete_rest_marks drop constraint pilot_athlete_rest_marks_clear_check'],
    ['the read index dropped', 'drop index pilot.idx_athlete_rest_marks_athlete_days'],
    ['the one-live-mark index dropped', 'drop index pilot.uq_athlete_rest_marks_live_range'],
    ['the one-live-mark index not unique', `drop index pilot.uq_athlete_rest_marks_live_range;
       create index uq_athlete_rest_marks_live_range on pilot.athlete_rest_marks(organization_id, athlete_id, kind, first_day, last_day)
       where cleared_at is null`],
    ['the athlete foreign key without cascade', `alter table pilot.athlete_rest_marks drop constraint pilot_athlete_rest_marks_athlete_fk,
       add constraint pilot_athlete_rest_marks_athlete_fk foreign key (organization_id, athlete_id)
       references pilot.athletes(organization_id, athlete_id)`],
  ])('the runner refuses a table with %s, with everything else right', async (label, breakIt) => {
    const client = await freshDatabase(`restmarks_short_${label.replace(/[^a-z]+/g, '_')}`);
    try {
      await expect(applyMutationFree(client)).resolves.toBeUndefined();
      await client.query(breakIt);
      await expect(applyMutationFree(client)).rejects.toThrow(/ATHLETE_REST_MARKS_TABLE_NOT_READY/);
    } finally {
      await client.end();
    }
  });

  test('the database refuses an unknown kind, a non-staff marker, a bad range and a half-recorded clear', async () => {
    const client = await freshDatabase('restmarks_checks');
    try {
      await expect(insertRaw(client, { kind: 'sick' })).rejects.toThrow(/pilot_athlete_rest_marks_kind_check/);
      await expect(insertRaw(client, { marked_by_role: 'athlete' })).rejects.toThrow(/pilot_athlete_rest_marks_role_check/);
      await expect(insertRaw(client, { marked_by_role: 'parent' })).rejects.toThrow(/pilot_athlete_rest_marks_role_check/);
      await expect(insertRaw(client, { first_day: '2026-11-19', last_day: '2026-11-18' })).rejects.toThrow(/pilot_athlete_rest_marks_range_check/);
      await expect(insertRaw(client, { first_day: '2026-10-15', last_day: '2026-11-19' })).rejects.toThrow(/pilot_athlete_rest_marks_range_check/);
      await expect(insertRaw(client, { cleared_at: '2026-11-19T12:00:00Z' })).rejects.toThrow(/pilot_athlete_rest_marks_clear_check/);
      await expect(insertRaw(client, { cleared_by_account_id: COACH_ID })).rejects.toThrow(/pilot_athlete_rest_marks_clear_check/);
      await expect(insertRaw(client, { first_day: '2026-10-16', last_day: '2026-11-19' })).resolves.toBeDefined();
      await expect(insertRaw(client, { kind: 'away', marked_by_role: 'organization_admin', marked_by_account_id: ADMIN_ID })).resolves.toBeDefined();
    } finally {
      await client.end();
    }
  });

  test("a mark cannot name another gym's athlete, and goes with the athlete when the athlete is purged", async () => {
    const client = await freshDatabase('restmarks_fk');
    try {
      await expect(insertRaw(client, { athlete_id: OTHER_ATHLETE_ID })).rejects.toThrow(/pilot_athlete_rest_marks_athlete_fk/);
      await insertRaw(client, { athlete_id: SECOND_ATHLETE_ID });
      await client.query('delete from pilot.athletes where organization_id = $1 and athlete_id = $2', [ORG_ID, SECOND_ATHLETE_ID]);
      expect(await markCount(client)).toBe(0);
    } finally {
      await client.end();
    }
  });
});

describe('restMarks.ts against real rows', () => {
  test('one tap marks a week; the same tap again is the same mark; undo keeps the row', async () => {
    const client = await migratedDatabase('restmarks_flow');
    try {
      const first = await addRestMark({ actor: COACH, athleteId: ATHLETE_ID, kind: 'rest', ...THIS_WEEK, today: TODAY });
      expect(first.created).toBe(true);
      expect(first.mark).toMatchObject({ athlete_id: ATHLETE_ID, kind: 'rest', first_day: '2026-11-13', last_day: TODAY });
      expect(Object.keys(first.mark).sort()).toEqual(['athlete_id', 'first_day', 'kind', 'last_day', 'mark_id', 'marked_at']);

      const again = await addRestMark({ actor: ADMIN, athleteId: ATHLETE_ID, kind: 'rest', ...THIS_WEEK, today: TODAY });
      expect(again).toEqual({ mark: first.mark, created: false });
      expect(await markCount(client)).toBe(1);

      // Away over the same days is a different mark.
      const away = await addRestMark({ actor: COACH, athleteId: ATHLETE_ID, kind: 'away', ...THIS_WEEK, today: TODAY });
      expect(away.created).toBe(true);

      await clearRestMark({ actor: ADMIN, athleteId: ATHLETE_ID, markId: first.mark.mark_id });
      expect(await markCount(client)).toBe(2);
      expect(await markCount(client, { live: true })).toBe(1);
      const { rows } = await client.query(
        'select cleared_at, cleared_by_account_id from pilot.athlete_rest_marks where mark_id = $1',
        [first.mark.mark_id],
      );
      expect(rows[0].cleared_at).not.toBeNull();
      expect(rows[0].cleared_by_account_id).toBe(ADMIN_ID);

      // Cleared already, or not this athlete's: not found.
      await expect(clearRestMark({ actor: COACH, athleteId: ATHLETE_ID, markId: first.mark.mark_id })).rejects.toBeInstanceOf(NotFoundError);
      await expect(clearRestMark({ actor: COACH, athleteId: SECOND_ATHLETE_ID, markId: away.mark.mark_id })).rejects.toBeInstanceOf(NotFoundError);
      await expect(clearRestMark({ actor: COACH, athleteId: ATHLETE_ID, markId: 'not-a-uuid' })).rejects.toBeInstanceOf(ValidationError);

      // After undo, the same tap records a fresh mark.
      const redo = await addRestMark({ actor: COACH, athleteId: ATHLETE_ID, kind: 'rest', ...THIS_WEEK, today: TODAY });
      expect(redo.created).toBe(true);
      expect(redo.mark.mark_id).not.toBe(first.mark.mark_id);
    } finally {
      await client.end();
    }
  });

  test('a bad shape is refused before any row or audit is written', async () => {
    const client = await migratedDatabase('restmarks_shape');
    try {
      await expect(addRestMark({ actor: COACH, athleteId: ATHLETE_ID, kind: 'ill', ...THIS_WEEK, today: TODAY }))
        .rejects.toBeInstanceOf(ValidationError);
      await expect(addRestMark({ actor: COACH, athleteId: ATHLETE_ID, kind: 'rest', firstDay: TODAY, lastDay: '2026-11-13', today: TODAY }))
        .rejects.toBeInstanceOf(ValidationError);
      expect(await markCount(client)).toBe(0);
      expect(await auditRows(client)).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('the list returns live marks overlapping the window, for the named athletes, in this gym only', async () => {
    const client = await migratedDatabase('restmarks_list');
    try {
      const inside = await addRestMark({ actor: COACH, athleteId: ATHLETE_ID, kind: 'away', firstDay: '2026-11-01', lastDay: '2026-11-03', today: TODAY });
      // Straddles the window's first day: still overlapping.
      const straddle = await addRestMark({ actor: COACH, athleteId: SECOND_ATHLETE_ID, kind: 'rest', firstDay: '2026-10-16', lastDay: '2026-10-25', today: TODAY });
      // Ends the day before the window: left out.
      await addRestMark({ actor: COACH, athleteId: SECOND_ATHLETE_ID, kind: 'away', firstDay: '2026-10-16', lastDay: '2026-10-19', today: TODAY });
      const cleared = await addRestMark({ actor: COACH, athleteId: ATHLETE_ID, kind: 'rest', ...THIS_WEEK, today: TODAY });
      await clearRestMark({ actor: COACH, athleteId: ATHLETE_ID, markId: cleared.mark.mark_id });
      // The other gym's row for the SAME athlete id, and this gym's.
      await insertRaw(client, { organization_id: OTHER_ORG_ID, athlete_id: SHARED_ATHLETE_ID, marked_by_account_id: VISITING_COACH_ID });
      await addRestMark({ actor: COACH, athleteId: SHARED_ATHLETE_ID, kind: 'away', ...THIS_WEEK, today: TODAY });

      const listed = await listRestMarks(COACH, [ATHLETE_ID, SECOND_ATHLETE_ID], '2026-10-20', TODAY);
      expect(listed.map((row) => row.mark_id).sort()).toEqual([inside.mark.mark_id, straddle.mark.mark_id].sort());

      expect(await listRestMarks(COACH, [], '2026-10-20', TODAY)).toEqual([]);
      const there = await listRestMarks(OTHER_ADMIN, [SHARED_ATHLETE_ID], '2026-10-20', TODAY);
      expect(there.map((row) => row.kind)).toEqual(['rest']);
      const here = await listRestMarks(ADMIN, [SHARED_ATHLETE_ID], '2026-10-20', TODAY);
      expect(here.map((row) => row.kind)).toEqual(['away']);
    } finally {
      await client.end();
    }
  });

  test('every write is audited in the same transaction, naming no reason; an audit failure takes the mark with it', async () => {
    const client = await migratedDatabase('restmarks_audit');
    try {
      const { mark } = await addRestMark({ actor: COACH, athleteId: ATHLETE_ID, kind: 'rest', ...THIS_WEEK, today: TODAY });
      await addRestMark({ actor: COACH, athleteId: ATHLETE_ID, kind: 'rest', ...THIS_WEEK, today: TODAY }); // same mark: no second audit
      await clearRestMark({ actor: ADMIN, athleteId: ATHLETE_ID, markId: mark.mark_id });

      expect(await auditRows(client)).toEqual([
        {
          event_type: 'create', actor_account_id: COACH_ID, actor_role: 'coach', organization_id: ORG_ID, entity_id: mark.mark_id,
          details: { athlete_id: ATHLETE_ID, kind: 'rest', first_day: '2026-11-13', last_day: TODAY },
        },
        {
          event_type: 'update', actor_account_id: ADMIN_ID, actor_role: 'organization_admin', organization_id: ORG_ID, entity_id: mark.mark_id,
          details: { athlete_id: ATHLETE_ID, action: 'clear' },
        },
      ]);

      jest.spyOn(auditModule, 'writePilotAuditEvent').mockRejectedValueOnce(new Error('audit down'));
      await expect(addRestMark({ actor: COACH, athleteId: SECOND_ATHLETE_ID, kind: 'away', ...THIS_WEEK, today: TODAY }))
        .rejects.toThrow(/audit down/);
      const { rows: left } = await client.query('select 1 from pilot.athlete_rest_marks where athlete_id = $1', [SECOND_ATHLETE_ID]);
      expect(left).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test.each([
    ['the athlete', ATHLETE],
    ['a linked guardian', GUARDIAN],
    ['a volunteer', VOLUNTEER],
    ['the board', BOARD],
    ['the platform owner', PLATFORM_OWNER],
    ['a coach whose membership here lapsed', LAPSED_COACH],
    ["another gym's admin", OTHER_ADMIN],
    ['a coach signed in at their other gym', VISITING_COACH_AT_HOME],
  ])('%s may not mark, clear or read', async (label, actor) => {
    const client = await migratedDatabase(`restmarks_refuse_${label.replace(/[^a-z]+/g, '_')}`);
    try {
      const { mark } = await addRestMark({ actor: ADMIN, athleteId: ATHLETE_ID, kind: 'rest', ...THIS_WEEK, today: TODAY });
      await expect(addRestMark({ actor, athleteId: ATHLETE_ID, kind: 'away', ...THIS_WEEK, today: TODAY }))
        .rejects.toBeInstanceOf(ForbiddenError);
      await expect(clearRestMark({ actor, athleteId: ATHLETE_ID, markId: mark.mark_id })).rejects.toBeInstanceOf(ForbiddenError);
      if (actor.organizationId === ORG_ID) {
        await expect(listRestMarks(actor, [ATHLETE_ID], '2026-10-16', TODAY)).rejects.toBeInstanceOf(ForbiddenError);
      } else {
        // Staff at THEIR gym may read their gym's marks; this gym's mark is not among them.
        await expect(listRestMarks(actor, [ATHLETE_ID], '2026-10-16', TODAY)).resolves.toEqual([]);
      }
      expect(await markCount(client, { live: true })).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('staff here who reach the athlete may mark and clear: coach of record, covering coach, unassigned coach, admin', async () => {
    const client = await migratedDatabase('restmarks_allow');
    try {
      for (const actor of [COACH, VISITING_COACH, UNASSIGNED_COACH, ADMIN]) {
        const { mark } = await addRestMark({ actor, athleteId: ATHLETE_ID, kind: 'away', firstDay: TODAY, lastDay: TODAY, today: TODAY });
        await clearRestMark({ actor, athleteId: ATHLETE_ID, markId: mark.mark_id });
      }
      expect(await markCount(client)).toBe(4);
      expect(await markCount(client, { live: true })).toBe(0);
      // One refusal for every case, the same for an id that does not exist.
      await expect(addRestMark({ actor: COACH, athleteId: 'ath-does-not-exist', kind: 'rest', ...THIS_WEEK, today: TODAY }))
        .rejects.toThrow('This account may not record or read rest marks for this athlete.');
    } finally {
      await client.end();
    }
  });
});
