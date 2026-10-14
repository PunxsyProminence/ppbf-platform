// Real PostgreSQL-backed suite for
// infra/azure/pilot_slice_postgres_session_run_athletes_migration.sql (audit
// finding F-067): who was marked present in a session run, and a staff note on
// an athlete in a run.
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
// 1. ADDITIVE. It creates one table and widens one, changes no existing row,
//    leaves the athlete's own tables (pilot.sessions, pilot.athlete_check_ins)
//    and the run table as they were, and re-applies as a no-op.
// 2. The runner refuses a database where it never ran, and, for each key of
//    its readiness gate, at least one database where that rule is missing or
//    looser (the cases are listed below; they are examples, not every way a
//    rule could be loosened).
// 3. The rules the DATABASE holds: one mark per run and athlete; a mark names a
//    run and an athlete of the SAME gym; only a staff role marks; a mark taken
//    back keeps its row; a note is on a session or on a run, never both and
//    never neither; and a run note can only name an athlete marked present in
//    THAT run.
// 4. As the schema stands with this migration applied, the attendance view
//    does not read the new table: a mark is session detail, not attendance.
//    (A LATER migration changing that view is not something this suite sees.)
//
// No module is under test here: nothing on main reads or writes these objects
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-run-athletes-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-session-run-athletes-migration.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_session_run_athletes_migration.sql';

// Two template databases, cloned per test: the schema just BEFORE this
// migration, and the same with it applied.
const BEFORE = 'ppbf_test_f067_before';
const AFTER = 'ppbf_test_f067_after';

const ORG = 'org-f067-a';
const OTHER_ORG = 'org-f067-b';
const COACH = 'coach@org-f067-a';
const OTHER_COACH = 'coach@org-f067-b';
const ATHLETE = 'athlete-f067-1';
const SECOND_ATHLETE = 'athlete-f067-2';
const OTHER_ATHLETE = 'athlete-f067-other';
const SESSION = 'session-f067-1';
const RUN = 'ssrun-f067-plain';
const SECOND_RUN = 'ssrun-f067-second';
const OTHER_RUN = 'ssrun-f067-other';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let migrationFilesInOrder: string[];
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let databaseCount = 0;

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
  const name = `ppbf_test_f067_${databaseCount}`;
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

/** Two gyms, a coach and athletes in each, an athlete's own session, and live plain runs. */
async function seed(client: Client): Promise<void> {
  for (const [org, coach] of [[ORG, COACH], [OTHER_ORG, OTHER_COACH]] as const) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
    await client.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, 'coach', $2)`, [coach, org]);
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
       values ($1, $2, 'F067 Athlete', '2012-01-01', '100', 'active', 'contact', true, $3, now(), now())`,
      [org, athlete, coach],
    );
  }
  await client.query(
    `insert into pilot.sessions
       (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag, created_at, updated_at)
     values ($1, $2, $3, current_date, 5, 'UNKNOWN', 'the athlete''s own words', false, now(), now())`,
    [ORG, SESSION, ATHLETE],
  );
  // Plain runs (no script): the finding is about exactly these. One per coach
  // may be live, so the gym's second run is a settled one.
  for (const [org, run, coach, state] of [
    [ORG, RUN, COACH, 'in_progress'],
    [ORG, SECOND_RUN, COACH, 'completed'],
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
}

function mark(client: Client, overrides: Record<string, unknown> = {}) {
  return client.query(
    `insert into pilot.session_run_athletes
       (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role)
     values ($1, $2, $3, $4, $5)`,
    [
      overrides.organization_id ?? ORG,
      overrides.run_id ?? RUN,
      overrides.athlete_id ?? ATHLETE,
      overrides.marked_by_account_id ?? COACH,
      overrides.marked_by_role ?? 'coach',
    ],
  );
}

function note(client: Client, subject: { session_id?: string | null; run_id?: string | null; athlete_id?: string; organization_id?: string }) {
  return client.query(
    `insert into pilot.session_staff_notes
       (organization_id, note_id, session_id, run_id, athlete_id, author_account_id, author_role, note)
     values ($1, gen_random_uuid(), $2, $3, $4, $5, 'coach', 'Hands dropped in round two.')
     returning note_id`,
    [subject.organization_id ?? ORG, subject.session_id ?? null, subject.run_id ?? null, subject.athlete_id ?? ATHLETE, COACH],
  );
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
    // A staff note that exists before the migration: the row it must not change.
    await before.query(
      `insert into pilot.session_staff_notes
         (organization_id, note_id, session_id, athlete_id, author_account_id, author_role, note)
       values ($1, '11111111-1111-4111-8111-111111111111', $2, $3, $4, 'coach', 'Written before the migration.')`,
      [ORG, SESSION, ATHLETE, COACH],
    );
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
      'pilot_slice_postgres_session_scripts_migration.sql',
      'pilot_slice_postgres_session_run_state_migration.sql',
      'pilot_slice_postgres_session_run_plain_migration.sql',
      'pilot_slice_postgres_session_staff_notes_migration.sql',
    ]) {
      expect(position(dependency)).toBeGreaterThan(-1);
      expect(position(dependency)).toBeLessThan(position(MIGRATION_FILE));
    }
  });
});

describe('the migration is additive', () => {
  test('it creates the table and widens the notes table, changes no existing row, and re-applies as a no-op', async () => {
    const client = await cloneOf(BEFORE);
    try {
      expect((await client.query(`select to_regclass('pilot.session_run_athletes') as t`)).rows[0].t).toBeNull();
      expect(await columnNames(client, 'pilot.session_staff_notes')).not.toContain('run_id');
      const noteBefore = (await client.query(`select to_jsonb(n) as row from pilot.session_staff_notes n`)).rows;
      const untouched = ['pilot.sessions', 'pilot.athlete_check_ins', 'pilot.session_script_runs', 'pilot.athletes'];
      const shapeBefore = await Promise.all(untouched.map(async (table) => [
        await columnNames(client, table),
        await constraintNames(client, table),
      ]));
      const runsBefore = (await client.query(`select to_jsonb(r)::text as row from pilot.session_script_runs r order by run_id`)).rows;
      const sessionsBefore = (await client.query(`select to_jsonb(s)::text as row from pilot.sessions s order by session_id`)).rows;

      await applyMigrationTransaction(client, migrationSql);
      await mark(client);
      await note(client, { run_id: RUN });
      // The `all` chain re-runs every migration on every dispatch.
      await applyMigrationTransaction(client, migrationSql);

      // The note written before it is the same row, with the new column empty.
      const noteAfter = (await client.query(
        `select to_jsonb(n) as row from pilot.session_staff_notes n where note_id = '11111111-1111-4111-8111-111111111111'`,
      )).rows;
      expect(noteAfter).toEqual(noteBefore.map(({ row }) => ({ row: { ...row, run_id: null } })));
      // What was written between the two applications is still there.
      expect((await client.query(`select count(*)::int as n from pilot.session_run_athletes`)).rows[0].n).toBe(1);
      expect((await client.query(`select count(*)::int as n from pilot.session_staff_notes where run_id is not null`)).rows[0].n).toBe(1);
      // The athlete's own tables, the run table and the athlete table: same columns, same constraints, same rows.
      const shapeAfter = await Promise.all(untouched.map(async (table) => [
        await columnNames(client, table),
        await constraintNames(client, table),
      ]));
      expect(shapeAfter).toEqual(shapeBefore);
      expect((await client.query(`select to_jsonb(r)::text as row from pilot.session_script_runs r order by run_id`)).rows).toEqual(runsBefore);
      expect((await client.query(`select to_jsonb(s)::text as row from pilot.sessions s order by session_id`)).rows).toEqual(sessionsBefore);
    } finally {
      await client.end();
    }
  });

  test('a note on the athlete\'s own session is written exactly as before', async () => {
    const client = await cloneOf(AFTER);
    try {
      // The statement sessionStaffNotes.ts runs today: no run_id named at all.
      await client.query(
        `insert into pilot.session_staff_notes
           (organization_id, note_id, session_id, athlete_id, author_account_id, author_role, note)
         values ($1, gen_random_uuid(), $2, $3, $4, 'coach', 'After the migration, the old way.')`,
        [ORG, SESSION, ATHLETE, COACH],
      );
      const { rows } = await client.query(
        `select session_id, run_id from pilot.session_staff_notes where note = 'After the migration, the old way.'`,
      );
      expect(rows).toEqual([{ session_id: SESSION, run_id: null }]);
    } finally {
      await client.end();
    }
  });

  test('with this migration applied, the attendance view does not read the new table: a mark adds no attendance', async () => {
    const client = await cloneOf(AFTER);
    try {
      const view = await client.query(`select pg_get_viewdef('pilot.attendance_reconciled'::regclass, true) as definition`);
      expect(view.rows[0].definition).not.toMatch(/session_run_athletes/);
      await mark(client);
      const day = await client.query(
        `select count(*)::int as n from pilot.attendance_reconciled where organization_id = $1 and athlete_id = $2`,
        [ORG, ATHLETE],
      );
      expect(day.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });
});

describe('the runner', () => {
  /** The gate's refusal, naming exactly this key (not a longer key that ends with it). */
  const refusalNaming = (key: string) => new RegExp(`SESSION_RUN_ATHLETES_NOT_READY: (.*, )?${key}(, .*)?$`);

  test('refuses a database where the migration never ran, naming what is missing', async () => {
    const client = await cloneOf(BEFORE);
    try {
      await expect(readinessOnly(client)).rejects.toThrow(refusalNaming('table_ready'));
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

  const MARKS_TABLE = 'pilot.session_run_athletes';
  const NOTES_TABLE = 'pilot.session_staff_notes';

  // At least one case for EVERY key of the gate. Each is the migrated database with one rule
  // missing or looser and everything else right.
  test.each([
    // columns_ready
    ['the role column allowed to be null (a null role passes a check)', 'columns_ready',
      `alter table ${MARKS_TABLE} alter column marked_by_role drop not null`],
    ['who marked allowed to be null', 'columns_ready',
      `alter table ${MARKS_TABLE} alter column marked_by_account_id drop not null`],
    ['an extra column on the marks table', 'columns_ready',
      `alter table ${MARKS_TABLE} add column note text`],
    // primary_key_ready (dropping it takes the notes foreign key with it; both are named)
    ['the one-mark-per-run-and-athlete key dropped', 'primary_key_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_pkey cascade`],
    // organization_fk_ready
    ['the organization foreign key dropped', 'organization_fk_ready',
      `alter table ${MARKS_TABLE} drop constraint session_run_athletes_organization_id_fkey`],
    // run_fk_ready
    ['the run foreign key dropped', 'run_fk_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_run_fk`],
    ['the run foreign key without its cascade', 'run_fk_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_run_fk,
         add constraint pilot_session_run_athletes_run_fk foreign key (organization_id, run_id)
         references pilot.session_script_runs(organization_id, run_id)`],
    ['the run foreign key present but NOT VALID', 'run_fk_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_run_fk,
         add constraint pilot_session_run_athletes_run_fk foreign key (organization_id, run_id)
         references pilot.session_script_runs(organization_id, run_id) on delete cascade not valid`],
    // athlete_fk_ready
    ['the athlete foreign key dropped', 'athlete_fk_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_athlete_fk`],
    ['the athlete foreign key without its cascade', 'athlete_fk_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_athlete_fk,
         add constraint pilot_session_run_athletes_athlete_fk foreign key (organization_id, athlete_id)
         references pilot.athletes(organization_id, athlete_id)`],
    // marked_by_fk_ready / removed_by_fk_ready
    ['the who-marked foreign key dropped', 'marked_by_fk_ready',
      `alter table ${MARKS_TABLE} drop constraint session_run_athletes_marked_by_account_id_fkey`],
    ['the who-took-it-back foreign key dropped', 'removed_by_fk_ready',
      `alter table ${MARKS_TABLE} drop constraint session_run_athletes_removed_by_account_id_fkey`],
    // role_check_ready
    ['the role check widened to an athlete', 'role_check_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_role_check,
         add constraint pilot_session_run_athletes_role_check
         check (marked_by_role in ('coach', 'organization_admin', 'admin', 'athlete'))`],
    ['the role check widened to the platform owner', 'role_check_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_role_check,
         add constraint pilot_session_run_athletes_role_check
         check (marked_by_role in ('coach', 'organization_admin', 'admin', 'platform_owner'))`],
    ['the role check holding the three names and "or true"', 'role_check_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_role_check,
         add constraint pilot_session_run_athletes_role_check
         check (marked_by_role in ('coach', 'organization_admin', 'admin') or true)`],
    ['the role check turned inside out (anything BUT the three)', 'role_check_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_role_check,
         add constraint pilot_session_run_athletes_role_check
         check (marked_by_role not in ('coach', 'organization_admin', 'admin')) not valid`],
    // removed_pair_ready
    ['the removed pair check dropped', 'removed_pair_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_removed_pair`],
    ['the removed pair check made one-directional', 'removed_pair_ready',
      `alter table ${MARKS_TABLE} drop constraint pilot_session_run_athletes_removed_pair,
         add constraint pilot_session_run_athletes_removed_pair
         check ((removed_at is null) >= (removed_by_account_id is null))`],
    // athlete_index_ready
    ['the per-athlete index dropped', 'athlete_index_ready', 'drop index pilot.idx_session_run_athletes_athlete'],
    // notes_run_id_ready
    ['run_id on the notes table made NOT NULL', 'notes_run_id_ready',
      `delete from ${NOTES_TABLE}; alter table ${NOTES_TABLE} alter column run_id set not null`],
    // notes_session_id_nullable
    ['session_id made NOT NULL again', 'notes_session_id_nullable',
      `alter table ${NOTES_TABLE} alter column session_id set not null`],
    // notes_one_subject_ready
    ['the one-subject check dropped', 'notes_one_subject_ready',
      `alter table ${NOTES_TABLE} drop constraint pilot_session_staff_notes_one_subject`],
    ['the one-subject check loosened to "at least one"', 'notes_one_subject_ready',
      `alter table ${NOTES_TABLE} drop constraint pilot_session_staff_notes_one_subject,
         add constraint pilot_session_staff_notes_one_subject check (num_nonnulls(session_id, run_id) >= 1)`],
    // notes_run_athlete_fk_ready
    ['the present-in-this-run foreign key dropped', 'notes_run_athlete_fk_ready',
      `alter table ${NOTES_TABLE} drop constraint pilot_session_staff_notes_run_athlete_fk`],
    ['the present-in-this-run foreign key pointed at the run only', 'notes_run_athlete_fk_ready',
      `alter table ${NOTES_TABLE} drop constraint pilot_session_staff_notes_run_athlete_fk,
         add constraint pilot_session_staff_notes_run_athlete_fk foreign key (organization_id, run_id)
         references pilot.session_script_runs(organization_id, run_id) on delete cascade`],
    ['the present-in-this-run foreign key without its cascade', 'notes_run_athlete_fk_ready',
      `alter table ${NOTES_TABLE} drop constraint pilot_session_staff_notes_run_athlete_fk,
         add constraint pilot_session_staff_notes_run_athlete_fk foreign key (organization_id, run_id, athlete_id)
         references ${MARKS_TABLE}(organization_id, run_id, athlete_id)`],
    ['the present-in-this-run foreign key cross-wired (run and athlete swapped on the far side)', 'notes_run_athlete_fk_ready',
      `create unique index f067_swapped on ${MARKS_TABLE}(organization_id, athlete_id, run_id);
       alter table ${NOTES_TABLE} drop constraint pilot_session_staff_notes_run_athlete_fk,
         add constraint pilot_session_staff_notes_run_athlete_fk foreign key (organization_id, run_id, athlete_id)
         references ${MARKS_TABLE}(organization_id, athlete_id, run_id) on delete cascade`],
    // notes_run_index_ready
    ['the run notes index dropped', 'notes_run_index_ready', 'drop index pilot.idx_session_staff_notes_run'],
    ['the run notes index restricted to live notes (no use to the cascade)', 'notes_run_index_ready',
      `drop index pilot.idx_session_staff_notes_run;
       create index idx_session_staff_notes_run on ${NOTES_TABLE}(organization_id, run_id, athlete_id, created_at)
        where deleted_at is null and run_id is not null`],
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
      const keys = (error?.message ?? '').replace('SESSION_RUN_ATHLETES_NOT_READY: ', '').split(', ').sort();
      expect(keys).toEqual([
        'athlete_fk_ready', 'athlete_index_ready', 'columns_ready', 'marked_by_fk_ready', 'notes_one_subject_ready',
        'notes_run_athlete_fk_ready', 'notes_run_id_ready', 'notes_run_index_ready', 'notes_session_id_nullable',
        'organization_fk_ready', 'primary_key_ready', 'removed_by_fk_ready', 'removed_pair_ready', 'role_check_ready',
        'run_fk_ready', 'table_ready',
      ]);
    } finally {
      await client.end();
    }
  });
});

describe('what the database itself holds', () => {
  test('one mark per run and athlete; the same athlete may be marked in another run', async () => {
    const client = await cloneOf(AFTER);
    try {
      await mark(client);
      await expect(mark(client)).rejects.toThrow(/pilot_session_run_athletes_pkey/);
      await mark(client, { run_id: SECOND_RUN });
      await mark(client, { athlete_id: SECOND_ATHLETE });
      expect((await client.query(`select count(*)::int as n from pilot.session_run_athletes`)).rows[0].n).toBe(3);
    } finally {
      await client.end();
    }
  });

  test('a mark names a run and an athlete of the same gym, and only a staff role makes one', async () => {
    const client = await cloneOf(AFTER);
    try {
      // Another gym's athlete in this gym's run; this gym's athlete in another gym's run.
      await expect(mark(client, { athlete_id: OTHER_ATHLETE })).rejects.toThrow(/pilot_session_run_athletes_athlete_fk/);
      await expect(mark(client, { run_id: OTHER_RUN })).rejects.toThrow(/pilot_session_run_athletes_run_fk/);
      await expect(mark(client, { run_id: 'no-such-run' })).rejects.toThrow(/pilot_session_run_athletes_run_fk/);
      for (const role of ['athlete', 'parent', 'platform_owner', 'board', 'volunteer', 'staff', '']) {
        await expect(mark(client, { marked_by_role: role })).rejects.toThrow(/pilot_session_run_athletes_role_check/);
      }
      for (const [index, role] of ['coach', 'organization_admin', 'admin'].entries()) {
        await mark(client, { marked_by_role: role, athlete_id: index === 0 ? ATHLETE : SECOND_ATHLETE, run_id: index === 2 ? SECOND_RUN : RUN });
      }
      expect((await client.query(`select count(*)::int as n from pilot.session_run_athletes`)).rows[0].n).toBe(3);
    } finally {
      await client.end();
    }
  });

  test('a mark names an account that exists, and a scripted run holds marks as a plain one does', async () => {
    const client = await cloneOf(AFTER);
    try {
      await expect(mark(client, { marked_by_account_id: 'nobody@nowhere' })).rejects.toThrow(/marked_by_account_id_fkey/);

      // A script needs its gym's discipline row (pilot_session_scripts_discipline_fk).
      await client.query(
        `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
         values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
        [ORG],
      );
      await client.query(
        `insert into pilot.session_scripts (organization_id, script_id, lineage_id, version, name, created_by_account_id)
         values ($1, 'scr-f067', 'scr-f067', 1, 'Scripted', $2)`,
        [ORG, COACH],
      );
      await client.query(
        `insert into pilot.session_script_runs
           (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on,
            run_state, started_at, ended_at, paused_seconds)
         values ($1, 'ssrun-f067-scripted', 'scr-f067', 1, $2, current_date, 'completed', now() - interval '1 hour', now(), 0)`,
        [ORG, COACH],
      );
      await mark(client, { run_id: 'ssrun-f067-scripted' });
      await note(client, { run_id: 'ssrun-f067-scripted' });
    } finally {
      await client.end();
    }
  });

  test('deleting a run, an athlete or a mark row takes what hangs off it and nothing else', async () => {
    const client = await cloneOf(AFTER);
    try {
      const count = async (sql: string) => (await client.query(`select count(*)::int as n from ${sql}`)).rows[0].n;
      // The app deletes none of these (a mark taken back keeps its row); the retention purge
      // deletes athletes. This is what the foreign keys do when a row does go.
      await mark(client);
      await mark(client, { athlete_id: SECOND_ATHLETE });
      await mark(client, { run_id: SECOND_RUN });
      await note(client, { run_id: RUN });
      await note(client, { run_id: RUN, athlete_id: SECOND_ATHLETE });
      await note(client, { run_id: SECOND_RUN });
      const sessionNotes = await count(`pilot.session_staff_notes where session_id is not null`);

      // One mark row: its own run notes go; the other athlete's and the other run's stay.
      await client.query(
        `delete from pilot.session_run_athletes where organization_id = $1 and run_id = $2 and athlete_id = $3`,
        [ORG, RUN, SECOND_ATHLETE],
      );
      expect(await count(`pilot.session_staff_notes where run_id is not null`)).toBe(2);

      // A run: its marks and their notes go.
      await client.query(`delete from pilot.session_script_runs where organization_id = $1 and run_id = $2`, [ORG, RUN]);
      expect(await count(`pilot.session_run_athletes where run_id = '${RUN}'`)).toBe(0);
      expect(await count(`pilot.session_staff_notes where run_id = '${RUN}'`)).toBe(0);
      expect(await count(`pilot.session_run_athletes`)).toBe(1);

      // An athlete (what the retention purge does): their marks and run notes go.
      await client.query(`delete from pilot.athletes where organization_id = $1 and athlete_id = $2`, [ORG, ATHLETE]);
      expect(await count(`pilot.session_run_athletes`)).toBe(0);
      expect(await count(`pilot.session_staff_notes where run_id is not null`)).toBe(0);
      // The athlete's session notes went with the athlete too, as they did before this migration.
      expect(sessionNotes).toBe(1);
      expect(await count(`pilot.session_staff_notes`)).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('a mark taken back keeps its row, with who and when set together', async () => {
    const client = await cloneOf(AFTER);
    try {
      await mark(client);
      const where = `where organization_id = '${ORG}' and run_id = '${RUN}' and athlete_id = '${ATHLETE}'`;
      await expect(client.query(`update pilot.session_run_athletes set removed_at = now() ${where}`))
        .rejects.toThrow(/pilot_session_run_athletes_removed_pair/);
      await expect(client.query(`update pilot.session_run_athletes set removed_by_account_id = '${COACH}' ${where}`))
        .rejects.toThrow(/pilot_session_run_athletes_removed_pair/);

      await client.query(`update pilot.session_run_athletes set removed_at = now(), removed_by_account_id = '${COACH}' ${where}`);
      const removed = await client.query(`select removed_at is not null as removed from pilot.session_run_athletes ${where}`);
      expect(removed.rows).toEqual([{ removed: true }]);

      // Marked again: the same row, cleared.
      await client.query(`update pilot.session_run_athletes set removed_at = null, removed_by_account_id = null ${where}`);
      expect((await client.query(`select count(*)::int as n from pilot.session_run_athletes`)).rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });

  test('a note is on a session or on a run: never both, never neither', async () => {
    const client = await cloneOf(AFTER);
    try {
      await mark(client);
      await expect(note(client, { session_id: SESSION, run_id: RUN })).rejects.toThrow(/pilot_session_staff_notes_one_subject/);
      await expect(note(client, {})).rejects.toThrow(/pilot_session_staff_notes_one_subject/);
      await note(client, { session_id: SESSION });
      await note(client, { run_id: RUN });
    } finally {
      await client.end();
    }
  });

  test('a run note can only name an athlete marked present in THAT run', async () => {
    const client = await cloneOf(AFTER);
    try {
      await mark(client);
      // The second athlete is in the gym and the run exists, but nobody marked them in it.
      await expect(note(client, { run_id: RUN, athlete_id: SECOND_ATHLETE })).rejects.toThrow(/pilot_session_staff_notes_run_athlete_fk/);
      // The first athlete is marked in RUN, not in the second run.
      await expect(note(client, { run_id: SECOND_RUN })).rejects.toThrow(/pilot_session_staff_notes_run_athlete_fk/);
      // Another gym's run.
      await expect(note(client, { run_id: OTHER_RUN })).rejects.toThrow(/pilot_session_staff_notes_run_athlete_fk/);

      const written = await note(client, { run_id: RUN });
      expect(written.rows).toHaveLength(1);

      // Taking the mark back keeps the row, so the note written while it stood is kept too.
      await client.query(
        `update pilot.session_run_athletes set removed_at = now(), removed_by_account_id = $3
          where organization_id = $1 and run_id = $2 and athlete_id = $4`,
        [ORG, RUN, COACH, ATHLETE],
      );
      expect((await client.query(`select count(*)::int as n from pilot.session_staff_notes where run_id = $1`, [RUN])).rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });
});
