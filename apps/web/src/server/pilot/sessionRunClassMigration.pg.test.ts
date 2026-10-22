// Real PostgreSQL-backed suite for
// infra/azure/pilot_slice_postgres_session_run_class_migration.sql (D4,
// OD-2026-10-21-002): a live session tied to the scheduled class it is running,
// and the class register mark a "here" tap created.
//
// THE MIGRATION IS TESTED ON THE SCHEMA IT WILL MEET: `before` is the base
// schema plus every migration ahead of this one in the apply workflow's own
// order (scripts/lib/full-schema.mjs); the migration is then applied THROUGH
// ITS RUNNER, so the runner's readiness gate is exercised too. It is the same
// schema, not the same server: this is the embedded Postgres the suites use
// (18), and the runner's exact-text checks have not been run on the version
// staging and production run.
//
// What needs a real database to prove:
//
// 1. ADDITIVE. It adds nullable columns, keys and indexes, changes no existing
//    row, leaves the class register and the per-day attendance view exactly as
//    they were, and re-applies as a no-op.
// 2. The runner refuses a database where it never ran, and, for each key of
//    its readiness gate, at least one database where that rule is missing or
//    looser (examples, not every way a rule could be loosened).
// 3. The rules the DATABASE holds: a session ties only to a class of its own
//    gym; one live session per class; a deleted class unties the session and
//    keeps it; a register pointer names only the SAME athlete's register mark
//    in the same gym, always with its time, and no two session marks own the
//    same mark; a deleted register mark nulls only the pointer; an athlete's
//    or a class's delete goes through.
//
// No module is under test here: nothing on main reads or writes these columns
// yet. Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-run-class-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-session-run-class-migration.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_session_run_class_migration.sql';

// Two template databases, cloned per test: the schema just BEFORE this
// migration, and the same with it applied.
const BEFORE = 'ppbf_test_d4_before';
const AFTER = 'ppbf_test_d4_after';

const ORG = 'org-d4-a';
const OTHER_ORG = 'org-d4-b';
const COACH = 'coach@org-d4-a';
const SECOND_COACH = 'coach2@org-d4-a';
const OTHER_COACH = 'coach@org-d4-b';
const ATHLETE = 'athlete-d4-1';
const SECOND_ATHLETE = 'athlete-d4-2';
const OTHER_ATHLETE = 'athlete-d4-other';
const CLASS = 'class-d4-1';
const SECOND_CLASS = 'class-d4-2';
const OTHER_CLASS = 'class-d4-other';
const RUN = 'ssrun-d4-live';
const SECOND_RUN = 'ssrun-d4-second';
const DONE_RUN = 'ssrun-d4-done';
const OTHER_RUN = 'ssrun-d4-other';
const ATTENDANCE = 'att-d4-1';
const SECOND_ATTENDANCE = 'att-d4-2';
const OTHER_ATTENDANCE = 'att-d4-other';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let migrationFilesInOrder: string[];
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let databaseCount = 0;
/** The name of the database cloneOf made last, for a second connection to it. */
let lastClone = '';

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

async function asAdmin<T>(work: (admin: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  try {
    return await work(admin);
  } finally {
    await admin.end();
  }
}

/** A fresh copy of one of the two templates, connected. The caller ends it. */
async function cloneOf(template: typeof BEFORE | typeof AFTER): Promise<Client> {
  databaseCount += 1;
  const name = `ppbf_test_d4_${databaseCount}`;
  lastClone = name;
  await asAdmin(async (admin) => {
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name} template ${template}`);
  });
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

/** The runner's transaction with no SQL to apply: readiness alone decides. */
function readinessOnly(client: Client): Promise<void> {
  return applyMigrationTransaction(client, 'select 1');
}

/**
 * Two gyms; coaches and athletes in each; today's classes; a register mark for
 * the first athlete in each gym's first class; live plain runs (one per coach),
 * a finished one, and a who-is-here mark in the first run.
 */
async function seed(client: Client): Promise<void> {
  for (const [org, coaches] of [[ORG, [COACH, SECOND_COACH]], [OTHER_ORG, [OTHER_COACH]]] as const) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
    for (const coach of coaches) {
      await client.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, 'coach', $2)`, [coach, org]);
    }
  }
  for (const [org, athlete, coach] of [
    [ORG, ATHLETE, COACH],
    [ORG, SECOND_ATHLETE, COACH],
    [OTHER_ORG, OTHER_ATHLETE, OTHER_COACH],
  ] as const) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
          coach_id, created_at, updated_at)
       values ($1, $2, 'D4 Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
      [org, athlete, coach],
    );
  }
  for (const [org, klass, coach] of [
    [ORG, CLASS, COACH],
    [ORG, SECOND_CLASS, SECOND_COACH],
    [OTHER_ORG, OTHER_CLASS, OTHER_COACH],
  ] as const) {
    await client.query(
      `insert into pilot.scheduler_classes
         (organization_id, class_id, title, start_at, end_at, location, capacity,
          scheduled_by_account_id, coach_account_id, status)
       values ($1, $2, 'Youth boxing', now() - interval '10 minutes', now() + interval '50 minutes', 'Main floor', 20,
               $3, $3, 'open')`,
      [org, klass, coach],
    );
  }
  for (const [org, attendance, klass, athlete, coach] of [
    [ORG, ATTENDANCE, CLASS, ATHLETE, COACH],
    [ORG, SECOND_ATTENDANCE, CLASS, SECOND_ATHLETE, COACH],
    [OTHER_ORG, OTHER_ATTENDANCE, OTHER_CLASS, OTHER_ATHLETE, OTHER_COACH],
  ] as const) {
    await client.query(
      `insert into pilot.scheduler_attendance
         (organization_id, attendance_id, class_id, athlete_id, status, method, checked_in_by_role,
          checked_in_by_account_id, checked_in_at, updated_at)
       values ($1, $2, $3, $4, 'present', 'coach_override', 'coach', $5, now(), now())`,
      [org, attendance, klass, athlete, coach],
    );
  }
  // One live run per coach may exist (pilot_ssrun_one_live_per_coach), so each live run here
  // belongs to a different coach.
  for (const [org, run, coach, state] of [
    [ORG, RUN, COACH, 'in_progress'],
    [ORG, SECOND_RUN, SECOND_COACH, 'in_progress'],
    [ORG, DONE_RUN, COACH, 'completed'],
    [OTHER_ORG, OTHER_RUN, OTHER_COACH, 'in_progress'],
  ] as const) {
    await client.query(
      `insert into pilot.session_script_runs
         (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on,
          run_state, started_at, ended_at, paused_seconds)
       values ($1, $2, null, null, $3, current_date, $4, now() - interval '20 minutes',
               case when $4 = 'in_progress' then null else now() end, 0)`,
      [org, run, coach, state],
    );
  }
  await client.query(
    `insert into pilot.session_run_athletes (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role)
     values ($1, $2, $3, $4, 'coach')`,
    [ORG, RUN, ATHLETE, COACH],
  );
}

function tie(client: Client, run: string, klass: string | null, org = ORG) {
  return client.query(
    `update pilot.session_script_runs set class_id = $3 where organization_id = $1 and run_id = $2`,
    [org, run, klass],
  );
}

/** Point a session mark at the register mark of `klass` (for the mark's own athlete), or clear it. */
function point(client: Client, klass: string | null, writtenAt: string | null, overrides: { run?: string; athlete?: string } = {}) {
  return client.query(
    `update pilot.session_run_athletes set register_class_id = $4, register_written_at = $5::timestamptz
      where organization_id = $1 and run_id = $2 and athlete_id = $3`,
    [ORG, overrides.run ?? RUN, overrides.athlete ?? ATHLETE, klass, writtenAt],
  );
}

async function markRow(client: Client, run = RUN, athlete = ATHLETE) {
  const { rows } = await client.query(
    `select to_jsonb(m) as row from pilot.session_run_athletes m where organization_id = $1 and run_id = $2 and athlete_id = $3`,
    [ORG, run, athlete],
  );
  return rows[0]?.row as Record<string, unknown> | undefined;
}

async function constraintNames(client: Client, table: string): Promise<string[]> {
  const { rows } = await client.query<{ conname: string }>(
    `select conname from pg_constraint where conrelid = $1::regclass order by conname`,
    [table],
  );
  return rows.map((row) => row.conname);
}

async function columnNames(client: Client, table: string): Promise<string[]> {
  const { rows } = await client.query<{ attname: string }>(
    `select attname from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped order by attnum`,
    [table],
  );
  return rows.map((row) => row.attname);
}

async function indexNames(client: Client, table: string): Promise<string[]> {
  const { rows } = await client.query<{ indexname: string }>(
    `select indexname from pg_indexes where schemaname || '.' || tablename = $1 order by indexname`,
    [table],
  );
  return rows.map((row) => row.indexname);
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const listMigrationFiles = helper.listMigrationFiles as (infraDir?: string) => Promise<string[]>;
  const baseSchemaFile = helper.BASE_SCHEMA_FILE as string;
  const runner = await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href);
  applyMigrationTransaction = runner.applyMigrationTransaction as typeof applyMigrationTransaction;
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  migrationFilesInOrder = await listMigrationFiles(INFRA_DIR);

  // BEFORE: the base schema, then every migration ahead of this one, in the
  // workflow's order, each in its own transaction (as applyFullSchema does).
  const ahead = migrationFilesInOrder.slice(0, migrationFilesInOrder.indexOf(MIGRATION_FILE));
  await asAdmin(async (admin) => {
    await admin.query(`drop database if exists ${AFTER}`);
    await admin.query(`drop database if exists ${BEFORE}`);
    await admin.query(`create database ${BEFORE}`);
  });
  const before = new Client({ connectionString: connectionStringFor(BEFORE) });
  await before.connect();
  try {
    await before.query(await fs.readFile(path.join(INFRA_DIR, baseSchemaFile), 'utf8'));
    for (const file of ahead) {
      await before.query('BEGIN');
      await before.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
      await before.query('COMMIT');
    }
    await seed(before);
  } finally {
    await before.end();
  }

  // AFTER: a copy of BEFORE with the migration applied through its runner.
  await asAdmin((admin) => admin.query(`create database ${AFTER} template ${BEFORE}`));
  const after = new Client({ connectionString: connectionStringFor(AFTER) });
  await after.connect();
  try {
    await applyMigrationTransaction(after, migrationSql);
  } finally {
    await after.end();
  }
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
  // On Windows kill() terminates the server script outright, so its own
  // cleanup never runs and Postgres may still hold files here for a moment.
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
});

describe('where the migration sits', () => {
  test('it is applied after every migration it depends on', () => {
    const position = (file: string) => migrationFilesInOrder.indexOf(file);

    expect(position(MIGRATION_FILE)).toBeGreaterThan(-1);
    for (const dependency of [
      'pilot_slice_postgres_scheduler_tables_migration.sql',
      'pilot_slice_postgres_session_scripts_migration.sql',
      'pilot_slice_postgres_session_run_state_migration.sql',
      'pilot_slice_postgres_session_run_plain_migration.sql',
      'pilot_slice_postgres_session_run_athletes_migration.sql',
    ]) {
      expect(position(dependency)).toBeGreaterThan(-1);
      expect(position(dependency)).toBeLessThan(position(MIGRATION_FILE));
    }
  });
});

describe('the migration is additive', () => {
  test('it adds the columns, changes no existing row, leaves the register and the per-day view alone, and re-applies as a no-op', async () => {
    const client = await cloneOf(BEFORE);
    try {
      expect(await columnNames(client, 'pilot.session_script_runs')).not.toContain('class_id');
      expect(await columnNames(client, 'pilot.session_run_athletes')).not.toContain('register_class_id');

      const rows = async (table: string, key: string) =>
        (await client.query(`select to_jsonb(t) as row from ${table} t order by ${key}`)).rows.map(({ row }) => row);
      const runsBefore = await rows('pilot.session_script_runs', 'run_id');
      const marksBefore = await rows('pilot.session_run_athletes', 'athlete_id');
      const registerBefore = await rows('pilot.scheduler_attendance', 'attendance_id');
      const untouched = ['pilot.scheduler_attendance', 'pilot.scheduler_classes', 'pilot.scheduler_registrations', 'pilot.activity_log'];
      const shapeBefore = await Promise.all(untouched.map(async (table) => [
        await columnNames(client, table),
        await constraintNames(client, table),
        await indexNames(client, table),
      ]));
      const viewBefore = (await client.query(
        `select pg_get_viewdef('pilot.attendance_reconciled'::regclass, true) as definition`,
      )).rows[0].definition;
      const dayBefore = (await client.query(
        `select to_jsonb(v)::text as row from pilot.attendance_reconciled v order by 1`,
      )).rows;

      await applyMigrationTransaction(client, migrationSql);
      await tie(client, RUN, CLASS);
      // The `all` chain re-runs every migration on every dispatch.
      await applyMigrationTransaction(client, migrationSql);

      // Existing rows are the same rows, with the new columns empty (the tie made between the
      // two applications aside, which the re-run kept).
      expect(await rows('pilot.session_script_runs', 'run_id')).toEqual(
        runsBefore.map((row) => ({ ...row, class_id: row.run_id === RUN ? CLASS : null })),
      );
      expect(await rows('pilot.session_run_athletes', 'athlete_id')).toEqual(
        marksBefore.map((row) => ({ ...row, register_class_id: null, register_written_at: null })),
      );
      // The register, the class and registration tables and the activity log: same rows, same
      // columns, same constraints, same indexes. The per-day view: the same definition, the same rows.
      expect(await rows('pilot.scheduler_attendance', 'attendance_id')).toEqual(registerBefore);
      const shapeAfter = await Promise.all(untouched.map(async (table) => [
        await columnNames(client, table),
        await constraintNames(client, table),
        await indexNames(client, table),
      ]));
      expect(shapeAfter).toEqual(shapeBefore);
      expect((await client.query(
        `select pg_get_viewdef('pilot.attendance_reconciled'::regclass, true) as definition`,
      )).rows[0].definition).toBe(viewBefore);
      expect((await client.query(`select to_jsonb(v)::text as row from pilot.attendance_reconciled v order by 1`)).rows)
        .toEqual(dayBefore);
    } finally {
      await client.end();
    }
  });

  test('the statements the app runs today still work unchanged: a start names no class, a mark names no register row', async () => {
    const client = await cloneOf(AFTER);
    try {
      await client.query(
        `insert into pilot.session_script_runs
           (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on,
            run_state, started_at, ended_at, paused_seconds)
         values ($1, 'ssrun-d4-today', null, null, $2, current_date, 'completed', now() - interval '1 hour', now(), 0)`,
        [ORG, SECOND_COACH],
      );
      await client.query(
        `insert into pilot.session_run_athletes (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role)
         values ($1, $2, $3, $4, 'coach')`,
        [ORG, RUN, SECOND_ATHLETE, COACH],
      );
      const run = await client.query(`select class_id from pilot.session_script_runs where run_id = 'ssrun-d4-today'`);
      expect(run.rows).toEqual([{ class_id: null }]);
      const marked = await markRow(client, RUN, SECOND_ATHLETE);
      expect(marked).toMatchObject({ register_class_id: null, register_written_at: null });
    } finally {
      await client.end();
    }
  });
});

describe('the `all` chain re-runs the runners ahead of it', () => {
  test('the session-run-athletes runner still passes on a database that has the two new columns', async () => {
    const client = await cloneOf(AFTER);
    try {
      const earlier = await nativeDynamicImport(pathToFileURL(
        path.resolve(__dirname, '../../../scripts/pilot-apply-session-run-athletes-migration.mjs'),
      ).href);
      const earlierSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_session_run_athletes_migration.sql'), 'utf8');
      await expect((earlier.applyMigrationTransaction as typeof applyMigrationTransaction)(client, earlierSql)).resolves.toBeUndefined();
      // And it still refuses an extra column nobody added on purpose.
      await client.query('alter table pilot.session_run_athletes add column stray text');
      await expect((earlier.applyMigrationTransaction as typeof applyMigrationTransaction)(client, 'select 1'))
        .rejects.toThrow(/SESSION_RUN_ATHLETES_NOT_READY: (.*, )?columns_ready/);
    } finally {
      await client.end();
    }
  });
});

describe('the runner', () => {
  /** The gate's refusal, naming exactly this key (not a longer key that ends with it). */
  const refusalNaming = (key: string) => new RegExp(`SESSION_RUN_CLASS_NOT_READY: (.*, )?${key}(, .*)?$`);

  test('refuses a database where the migration never ran, naming what is missing', async () => {
    const client = await cloneOf(BEFORE);
    try {
      await expect(readinessOnly(client)).rejects.toThrow(refusalNaming('run_class_column_ready'));
    } finally {
      await client.end();
    }
  });

  test('passes on a database where it ran', async () => {
    const client = await cloneOf(AFTER);
    try {
      await expect(readinessOnly(client)).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });

  const RUNS_TABLE = 'pilot.session_script_runs';
  const MARKS_TABLE = 'pilot.session_run_athletes';

  // At least one case for EVERY key of the gate. Each is the migrated database with one rule
  // missing or looser and everything else right.
  test.each([
    // run_class_column_ready
    ['class_id with a default', 'run_class_column_ready',
      `alter table ${RUNS_TABLE} alter column class_id set default 'class-x'`],
    ['class_id NOT NULL', 'run_class_column_ready',
      `drop index pilot.pilot_ssrun_one_live_per_class;
       update ${RUNS_TABLE} set class_id = '${CLASS}' where organization_id = '${ORG}';
       delete from ${RUNS_TABLE} where organization_id <> '${ORG}';
       alter table ${RUNS_TABLE} alter column class_id set not null`],
    // run_class_fk_ready
    ['the class key dropped', 'run_class_fk_ready',
      `alter table ${RUNS_TABLE} drop constraint pilot_ssrun_class_fk`],
    ['the class key cascading (a class delete would delete the session)', 'run_class_fk_ready',
      `alter table ${RUNS_TABLE} drop constraint pilot_ssrun_class_fk,
         add constraint pilot_ssrun_class_fk foreign key (organization_id, class_id)
         references pilot.scheduler_classes(organization_id, class_id) on delete cascade`],
    ['the class key nulling the whole key (organization_id too)', 'run_class_fk_ready',
      `alter table ${RUNS_TABLE} drop constraint pilot_ssrun_class_fk,
         add constraint pilot_ssrun_class_fk foreign key (organization_id, class_id)
         references pilot.scheduler_classes(organization_id, class_id) on delete set null`],
    ['the class key with no delete action', 'run_class_fk_ready',
      `alter table ${RUNS_TABLE} drop constraint pilot_ssrun_class_fk,
         add constraint pilot_ssrun_class_fk foreign key (organization_id, class_id)
         references pilot.scheduler_classes(organization_id, class_id)`],
    ['the class key NOT VALID', 'run_class_fk_ready',
      `alter table ${RUNS_TABLE} drop constraint pilot_ssrun_class_fk,
         add constraint pilot_ssrun_class_fk foreign key (organization_id, class_id)
         references pilot.scheduler_classes(organization_id, class_id) on delete set null (class_id) not valid`],
    ['the class key on class_id alone (any gym\'s class)', 'run_class_fk_ready',
      `create unique index d4_class_id_only on pilot.scheduler_classes(class_id);
       alter table ${RUNS_TABLE} drop constraint pilot_ssrun_class_fk,
         add constraint pilot_ssrun_class_fk foreign key (class_id)
         references pilot.scheduler_classes(class_id) on delete set null (class_id)`],
    // one_live_per_class_ready
    ['the one-live-per-class index dropped', 'one_live_per_class_ready',
      'drop index pilot.pilot_ssrun_one_live_per_class'],
    ['the one-live-per-class index not unique', 'one_live_per_class_ready',
      `drop index pilot.pilot_ssrun_one_live_per_class;
       create index pilot_ssrun_one_live_per_class on ${RUNS_TABLE}(organization_id, class_id)
        where run_state = 'in_progress' and class_id is not null`],
    ['the one-live-per-class index over every run, finished ones too', 'one_live_per_class_ready',
      `drop index pilot.pilot_ssrun_one_live_per_class;
       create unique index pilot_ssrun_one_live_per_class on ${RUNS_TABLE}(organization_id, class_id)
        where class_id is not null`],
    ['the one-live-per-class index on class_id alone', 'one_live_per_class_ready',
      `drop index pilot.pilot_ssrun_one_live_per_class;
       create unique index pilot_ssrun_one_live_per_class on ${RUNS_TABLE}(class_id)
        where run_state = 'in_progress' and class_id is not null`],
    // run_class_index_ready
    ['the per-class index dropped', 'run_class_index_ready', 'drop index pilot.pilot_ssrun_class'],
    ['the per-class index restricted to live runs (no use to a class delete)', 'run_class_index_ready',
      `drop index pilot.pilot_ssrun_class;
       create index pilot_ssrun_class on ${RUNS_TABLE}(organization_id, class_id)
        where run_state = 'in_progress' and class_id is not null`],
    // register_class_column_ready
    ['register_class_id with a default', 'register_class_column_ready',
      `alter table ${MARKS_TABLE} alter column register_class_id set default '${CLASS}'`],
    ['register_class_id as an integer', 'register_class_column_ready',
      `alter table ${MARKS_TABLE} drop column register_class_id cascade;
       alter table ${MARKS_TABLE} add column register_class_id integer`],
    // register_written_column_ready
    ['register_written_at with a default', 'register_written_column_ready',
      `alter table ${MARKS_TABLE} alter column register_written_at set default now()`],
    ['register_written_at without a time zone', 'register_written_column_ready',
      `alter table ${MARKS_TABLE} alter column register_written_at type timestamp`],
    // register_fk_ready
    ['the register key dropped', 'register_fk_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_register_fk`],
    ['the register key cascading (a register delete would delete the session mark)', 'register_fk_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_register_fk,
         add constraint pilot_session_run_athletes_register_fk foreign key (organization_id, register_class_id, athlete_id)
         references pilot.scheduler_attendance(organization_id, class_id, athlete_id) on delete cascade`],
    ['the register key nulling the whole key (the athlete and the gym too)', 'register_fk_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_register_fk,
         add constraint pilot_session_run_athletes_register_fk foreign key (organization_id, register_class_id, athlete_id)
         references pilot.scheduler_attendance(organization_id, class_id, athlete_id) on delete set null`],
    ['the register key NOT VALID', 'register_fk_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_register_fk,
         add constraint pilot_session_run_athletes_register_fk foreign key (organization_id, register_class_id, athlete_id)
         references pilot.scheduler_attendance(organization_id, class_id, athlete_id)
         on delete set null (register_class_id) not valid`],
    ['the register key pointing at the class only (any athlete\'s mark of it)', 'register_fk_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_register_fk,
         add constraint pilot_session_run_athletes_register_fk foreign key (organization_id, register_class_id)
         references pilot.scheduler_classes(organization_id, class_id) on delete set null (register_class_id)`],
    ['the register key cross-wired (class and athlete swapped on the far side)', 'register_fk_ready',
      `create unique index d4_attendance_swapped on pilot.scheduler_attendance(organization_id, athlete_id, class_id);
       alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_register_fk,
         add constraint pilot_session_run_athletes_register_fk foreign key (organization_id, register_class_id, athlete_id)
         references pilot.scheduler_attendance(organization_id, athlete_id, class_id) on delete set null (register_class_id)`],
    // register_written_check_ready
    ['the pointer-carries-its-time check dropped', 'register_written_check_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_register_written`],
    ['the pointer-carries-its-time check turned around (a time needs a pointer)', 'register_written_check_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_register_written,
         add constraint pilot_session_run_athletes_register_written
         check (register_written_at is null or register_class_id is not null)`],
    ['the pointer-carries-its-time check holding "or true"', 'register_written_check_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_register_written,
         add constraint pilot_session_run_athletes_register_written
         check (register_class_id is null or register_written_at is not null or true)`],
    // register_owner_index_ready
    ['the one-owner index dropped', 'register_owner_index_ready',
      'drop index pilot.pilot_session_run_athletes_register_owner'],
    ['the one-owner index not unique', 'register_owner_index_ready',
      `drop index pilot.pilot_session_run_athletes_register_owner;
       create index pilot_session_run_athletes_register_owner on ${MARKS_TABLE}(organization_id, register_class_id, athlete_id)
        where register_class_id is not null`],
    ['the one-owner index per run (two sessions could own one register mark)', 'register_owner_index_ready',
      `drop index pilot.pilot_session_run_athletes_register_owner;
       create unique index pilot_session_run_athletes_register_owner
        on ${MARKS_TABLE}(organization_id, run_id, register_class_id, athlete_id)
        where register_class_id is not null`],
  ])('refuses a database with %s, and names it (%s)', async (_label, missing, breakIt) => {
    const client = await cloneOf(AFTER);
    try {
      // Outside the expectation: if the sabotage itself fails, the test fails here, not "passes".
      await client.query(breakIt);
      await expect(readinessOnly(client)).rejects.toThrow(refusalNaming(missing));
    } finally {
      await client.end();
    }
  });

  test('every key of the gate has a case above', async () => {
    const client = await cloneOf(BEFORE);
    try {
      // On a database where nothing of it exists, the refusal names every key the gate has.
      const error = await readinessOnly(client).then(() => null, (caught: Error) => caught);
      const keys = (error?.message ?? '').replace('SESSION_RUN_CLASS_NOT_READY: ', '').split(', ').sort();
      expect(keys).toEqual([
        'one_live_per_class_ready', 'register_class_column_ready', 'register_fk_ready', 'register_owner_index_ready',
        'register_written_check_ready', 'register_written_column_ready', 'run_class_column_ready',
        'run_class_fk_ready', 'run_class_index_ready',
      ]);
    } finally {
      await client.end();
    }
  });

  test('holds its locks for at most 10 seconds, and leaves nothing behind when it gives up', async () => {
    const client = await cloneOf(BEFORE);
    const blocker = new Client({ connectionString: connectionStringFor(lastClone) });
    await blocker.connect();
    try {
      // Another transaction holding the register table, as a long register write would.
      await blocker.query('BEGIN');
      await blocker.query('lock table pilot.scheduler_attendance in access exclusive mode');
      const started = Date.now();
      await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow(/lock timeout/i);
      expect(Date.now() - started).toBeLessThan(30_000);
      await blocker.query('ROLLBACK');
      expect(await columnNames(client, 'pilot.session_script_runs')).not.toContain('class_id');
      expect(await columnNames(client, 'pilot.session_run_athletes')).not.toContain('register_class_id');
    } finally {
      await blocker.end();
      await client.end();
    }
  });
});

describe('what the database itself holds', () => {
  test('a session ties only to a class of its own gym, and may be untied', async () => {
    const client = await cloneOf(AFTER);
    try {
      await expect(tie(client, RUN, OTHER_CLASS)).rejects.toThrow(/pilot_ssrun_class_fk/);
      await expect(tie(client, RUN, 'no-such-class')).rejects.toThrow(/pilot_ssrun_class_fk/);
      await tie(client, RUN, CLASS);
      await tie(client, RUN, null);
      await tie(client, OTHER_RUN, OTHER_CLASS, OTHER_ORG);
    } finally {
      await client.end();
    }
  });

  test('one live session per class; a finished one, another class, or no class are not limited', async () => {
    const client = await cloneOf(AFTER);
    try {
      await tie(client, RUN, CLASS);
      // A second coach's live session cannot run the same class.
      await expect(tie(client, SECOND_RUN, CLASS)).rejects.toThrow(/pilot_ssrun_one_live_per_class/);
      // A finished session of the class is not counted.
      await tie(client, DONE_RUN, CLASS);
      // Another class is fine, and so are two live sessions tied to nothing (the default today).
      await tie(client, SECOND_RUN, SECOND_CLASS);
      await tie(client, SECOND_RUN, null);
      // Once the first session ends, another may run the class.
      await client.query(
        `update pilot.session_script_runs set run_state = 'completed', ended_at = now(), current_block_id = null
          where organization_id = $1 and run_id = $2`,
        [ORG, RUN],
      );
      await tie(client, SECOND_RUN, CLASS);
      const live = await client.query(
        `select count(*)::int as n from pilot.session_script_runs where class_id = $1 and run_state = 'in_progress'`,
        [CLASS],
      );
      expect(live.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('a register pointer names only this athlete\'s own register mark, always with its time, and one owner per mark', async () => {
    const client = await cloneOf(AFTER);
    const writtenAt = '2026-10-21T22:00:00.123Z';
    try {
      // Another gym's class; a class this athlete has no register mark in; no class at all.
      await expect(point(client, OTHER_CLASS, writtenAt)).rejects.toThrow(/pilot_session_run_athletes_register_fk/);
      await expect(point(client, SECOND_CLASS, writtenAt)).rejects.toThrow(/pilot_session_run_athletes_register_fk/);
      await expect(point(client, 'no-such-class', writtenAt)).rejects.toThrow(/pilot_session_run_athletes_register_fk/);
      // A pointer without its time.
      await expect(point(client, CLASS, null)).rejects.toThrow(/pilot_session_run_athletes_register_written/);

      // ANOTHER CHILD'S MARK: the first athlete has a register mark in the second class, the
      // second athlete does not. The second athlete's session mark cannot point there, because the
      // key uses the session mark's own athlete.
      await client.query(
        `insert into pilot.scheduler_attendance
           (organization_id, attendance_id, class_id, athlete_id, status, method, checked_in_by_role,
            checked_in_by_account_id, checked_in_at, updated_at)
         values ($1, 'att-d4-second-class', $2, $3, 'present', 'coach_override', 'coach', $4, now(), now())`,
        [ORG, SECOND_CLASS, ATHLETE, SECOND_COACH],
      );
      await client.query(
        `insert into pilot.session_run_athletes (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role)
         values ($1, $2, $3, $4, 'coach')`,
        [ORG, RUN, SECOND_ATHLETE, COACH],
      );
      await expect(point(client, SECOND_CLASS, writtenAt, { athlete: SECOND_ATHLETE }))
        .rejects.toThrow(/pilot_session_run_athletes_register_fk/);

      await point(client, CLASS, writtenAt);
      const marked = await markRow(client);
      expect(marked?.register_class_id).toBe(CLASS);
      expect(new Date(String(marked?.register_written_at)).toISOString()).toBe(writtenAt);

      // The same athlete marked in a second session of that class cannot also claim the mark.
      await client.query(
        `insert into pilot.session_run_athletes (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role)
         values ($1, $2, $3, $4, 'coach')`,
        [ORG, SECOND_RUN, ATHLETE, SECOND_COACH],
      );
      await expect(point(client, CLASS, writtenAt, { run: SECOND_RUN }))
        .rejects.toThrow(/pilot_session_run_athletes_register_owner/);
      // Another athlete's mark in the same session may own THEIR OWN mark of the class.
      await point(client, CLASS, writtenAt, { athlete: SECOND_ATHLETE });

      // Cleared together, as the app's undo does.
      await point(client, null, null);
      expect(await markRow(client)).toMatchObject({ register_class_id: null, register_written_at: null });
    } finally {
      await client.end();
    }
  });

  test('a deleted register mark nulls only the pointer: the session mark stays, its athlete and time kept', async () => {
    const client = await cloneOf(AFTER);
    try {
      await point(client, CLASS, '2026-10-21T22:00:00Z');
      const before = await markRow(client);
      await client.query(`delete from pilot.scheduler_attendance where organization_id = $1 and attendance_id = $2`, [ORG, ATTENDANCE]);
      const after = await markRow(client);
      expect(after).toEqual({ ...before, register_class_id: null });
      expect(after?.athlete_id).toBe(ATHLETE);
      expect(after?.register_written_at).not.toBeNull();
      expect(after?.organization_id).toBe(ORG);
    } finally {
      await client.end();
    }
  });

  test('a deleted class unties its sessions and keeps them, and its register rows release their pointers', async () => {
    const client = await cloneOf(AFTER);
    try {
      await tie(client, RUN, CLASS);
      await tie(client, DONE_RUN, CLASS);
      await point(client, CLASS, '2026-10-21T22:00:00Z');
      const runsBefore = (await client.query(
        `select run_id, organization_id, run_state from pilot.session_script_runs where organization_id = $1 order by run_id`,
        [ORG],
      )).rows;

      // The app deletes no class; the organization delete cascades to it. This is what the keys do
      // when one does go: the register rows go with their class (as before), each session keeps its
      // row and its gym, and loses only the tie.
      await client.query(`delete from pilot.scheduler_classes where organization_id = $1 and class_id = $2`, [ORG, CLASS]);

      const runsAfter = await client.query(
        `select run_id, organization_id, run_state, class_id from pilot.session_script_runs where organization_id = $1 order by run_id`,
        [ORG],
      );
      expect(runsAfter.rows).toEqual(runsBefore.map((row) => ({ ...row, class_id: null })));
      expect(await markRow(client)).toMatchObject({ athlete_id: ATHLETE, register_class_id: null });
    } finally {
      await client.end();
    }
  });

  test('an athlete delete (the retention purge) goes through: their register rows and session marks both go', async () => {
    const client = await cloneOf(AFTER);
    try {
      await tie(client, RUN, CLASS);
      await point(client, CLASS, '2026-10-21T22:00:00Z');
      await client.query(`delete from pilot.athletes where organization_id = $1 and athlete_id = $2`, [ORG, ATHLETE]);
      expect(await markRow(client)).toBeUndefined();
      const left = await client.query(
        `select count(*)::int as n from pilot.scheduler_attendance where organization_id = $1 and athlete_id = $2`,
        [ORG, ATHLETE],
      );
      expect(left.rows[0].n).toBe(0);
      // The session and the other athlete's register mark are untouched.
      expect((await client.query(`select class_id from pilot.session_script_runs where run_id = $1`, [RUN])).rows)
        .toEqual([{ class_id: CLASS }]);
      expect((await client.query(`select count(*)::int as n from pilot.scheduler_attendance where attendance_id = $1`, [SECOND_ATTENDANCE])).rows[0].n)
        .toBe(1);
    } finally {
      await client.end();
    }
  });
});
