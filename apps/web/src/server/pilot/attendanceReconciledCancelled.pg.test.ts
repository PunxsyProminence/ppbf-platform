// Real PostgreSQL contract test for
// pilot_slice_postgres_attendance_reconciled_cancelled_migration.sql (lane LV,
// OD-2026-10-22-001: "then classes need to be able to be canceled"; applied
// under OD-2026-10-21-005: a cancelled class's attendance stops counting, every
// row kept, staff still see them).
//
// What needs a real database to prove:
//
//   1. Over the view attendance-precedence left, the migration takes a
//      cancelled class's marks out of pilot.attendance_reconciled and nothing
//      else: a held class (open or full) still counts, a day with a held and a
//      cancelled class reads from the held one, and a day whose only class
//      marks were cancelled falls through to activity_log or the legacy table
//      exactly as the precedence order says.
//   2. activity_log and legacy days are unchanged, and no table loses or
//      changes a row: every scheduler_attendance row is still there.
//   3. The view's columns, their order and types, and the rest of its
//      definition are unchanged; re-applying is a no-op; un-cancelling brings
//      the marks back because the view is computed on read.
//   4. The runner's readiness refuses a result it did not produce.
//   5. On the schema production runs (every migration, in the `all` order),
//      the readers Lane LC (#1825) could not reach -- attendanceOnDay
//      (coach/attendance-today), getAttendanceLast28Days, the performance
//      rollup's training days and the passbook gap queue -- no longer count a
//      cancelled class. This part fails on main, where the view still counts
//      them.
//
// Spins up the same disposable, local-only embedded Postgres the other
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-attendance-reconciled-cancelled-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-attendance-reconciled-cancelled-migration.mjs',
);
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const MIGRATION_FILE = 'pilot_slice_postgres_attendance_reconciled_cancelled_migration.sql';
const PRECEDENCE_FILE = 'pilot_slice_postgres_attendance_precedence_migration.sql';

type Apply = (client: Client, sql: string) => Promise<void>;

// Jest's CJS transform turns a bare import() into require(), which cannot load
// an ESM runner; this keeps a real dynamic import (Node honours it under the
// --experimental-vm-modules flag every test:migrations:* script passes).
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

/* Routes the reader modules' own db calls at the embedded database, so part 5
   runs THEIR SQL rather than a copy of it. */
let activeClient: Client | null = null;
jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows[0] ?? null;
  }),
}));

import { gymDayIso } from '../../lib/gymTime';
import { attendanceOnDay, getAttendanceLast28Days } from './attendancePrecedence';
import { getCoachPassbookGapQueue } from './passbook';
import { getPerformanceRollup } from './performanceAnalytics';

const ORG = 'org-arc';
const COACH = 'acct-arc-coach';
const ADA = 'ath-arc-ada';
const BO = 'ath-arc-bo';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let activityLogSql: string;
let precedenceSql: string;
let migrationSql: string;

/* Loaded on first use, not in beforeAll: part 5 must still run (and fail) on a
   tree where this migration's runner does not exist yet. */
let runnerModule: Record<string, unknown> | null = null;
async function runner(): Promise<{ apply: Apply; filterText: string; columns: string[] }> {
  runnerModule ??= await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href);
  return {
    apply: runnerModule.applyMigrationTransaction as Apply,
    filterText: runnerModule.EXPECTED_FILTER_TEXT as string,
    columns: runnerModule.EXPECTED_COLUMNS as string[],
  };
}
async function migration(): Promise<string> {
  migrationSql ??= await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  return migrationSql;
}

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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function emptyDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

async function seedGym(client: Client): Promise<void> {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
     values ($1, 'coach', $2, 'microsoft', true)`,
    [COACH, ORG],
  );
  for (const athleteId of [ADA, BO]) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $3, '2012-01-01', '100', 'active', 'contact', true, $4, now(), now())`,
      [ORG, athleteId, `Athlete ${athleteId}`, COACH],
    );
  }
}

/** The view as attendance-precedence left it: base schema, activity_log, the precedence migration. */
async function precedenceDatabase(name: string): Promise<Client> {
  const client = await emptyDatabase(name);
  await client.query(baseSchemaSql);
  await client.query(activityLogSql);
  await seedGym(client);
  await client.query(precedenceSql);
  return client;
}

type ClassStatus = 'open' | 'full' | 'cancelled';

/** A class at 17:00 gym time on a gym-local day. */
async function addClass(client: Client, classId: string, localDate: string, status: ClassStatus): Promise<void> {
  await client.query(
    `insert into pilot.scheduler_classes
       (organization_id, class_id, title, start_at, end_at, location, capacity,
        scheduled_by_account_id, coach_account_id, status)
     values ($1, $2, $2,
             ($3 || ' 17:00')::timestamp at time zone 'America/New_York',
             ($3 || ' 18:00')::timestamp at time zone 'America/New_York',
             'Main floor', 20, $4, $4, $5)`,
    [ORG, classId, localDate, COACH, status],
  );
}

async function mark(
  client: Client,
  classId: string,
  athleteId: string,
  status: 'present' | 'absent' | 'excused',
): Promise<void> {
  await client.query(
    `insert into pilot.scheduler_attendance
       (organization_id, attendance_id, class_id, athlete_id, status, method,
        checked_in_by_role, checked_in_by_account_id, checked_in_at)
     values ($1, $2, $3, $4, $5, 'coach_override', 'coach', $6, now())`,
    [ORG, `sa-${classId}-${athleteId}`, classId, athleteId, status, COACH],
  );
}

async function legacy(client: Client, athleteId: string, date: string, status: string): Promise<void> {
  await client.query(
    `insert into pilot.attendance (organization_id, attendance_id, athlete_id, attendance_date, status)
     values ($1, gen_random_uuid(), $2, $3::date, $4)`,
    [ORG, athleteId, date, status],
  );
}

async function activity(
  client: Client,
  athleteId: string,
  date: string,
  status: 'present' | 'absent' | 'excused',
): Promise<void> {
  await client.query(
    `insert into pilot.activity_log
       (organization_id, activity_id, person_account_id, athlete_id, activity_domain,
        activity_type, occurred_on, duration_minutes, attendance_status, capture_method,
        recorded_by_role, recorded_by_account_id)
     values ($1, $2, $3, $4, 'boxing_training', 'technical_session', $5::date, 60, $6,
             'coach_override', 'coach', $3)`,
    [ORG, `al-${athleteId}-${date}`, COACH, athleteId, date, status],
  );
}

interface DayRow {
  athlete_id: string;
  attendance_date: string;
  status: string;
  source: string;
  class_marks_that_day: number;
  contributing_sources: number;
}

async function viewRows(client: Client): Promise<DayRow[]> {
  const result = await client.query<DayRow>(
    `select athlete_id, attendance_date::text as attendance_date, status, source,
            class_marks_that_day, contributing_sources
       from pilot.attendance_reconciled
      where organization_id = $1
      order by athlete_id, attendance_date`,
    [ORG],
  );
  return result.rows;
}

/** Every row of a table, whole, in a stable order. */
async function tableRows(client: Client, table: string, key: string): Promise<string[]> {
  const result = await client.query<{ row: string }>(
    `select to_jsonb(t)::text as row from ${table} t order by ${key}`,
  );
  return result.rows.map((r) => r.row);
}

async function viewShape(client: Client): Promise<string[]> {
  const result = await client.query<{ column: string }>(
    `select a.attname || ' ' || format_type(a.atttypid, a.atttypmod) as column
       from pg_attribute a
      where a.attrelid = 'pilot.attendance_reconciled'::regclass and a.attnum > 0 and not a.attisdropped
      order by a.attnum`,
  );
  return result.rows.map((r) => r.column);
}

async function viewDefinition(client: Client): Promise<string> {
  const result = await client.query<{ definition: string }>(
    `select pg_get_viewdef('pilot.attendance_reconciled'::regclass) as definition`,
  );
  return result.rows[0].definition;
}

/*
 * One gym, two athletes, a cancelled class and the days around it. Each day is
 * one case:
 *
 *   ADA 03-10  only a cancelled class, present              -> leaves the view
 *   ADA 03-11  a held (open) class, present                 -> unchanged
 *   ADA 03-12  cancelled present + held absent              -> absent, 1 mark
 *   ADA 03-13  cancelled present + legacy absent            -> falls to legacy: absent
 *   ADA 03-14  cancelled absent + activity_log present      -> activity_log, 1 source
 *   BO  03-10  the same cancelled class, present            -> leaves the view
 *   BO  03-15  activity_log only                            -> unchanged
 *   BO  03-16  legacy only ('late')                         -> unchanged
 *   BO  03-17  a held class that is FULL, present           -> unchanged (only 'cancelled' is left out)
 */
async function seedScenario(client: Client): Promise<void> {
  await addClass(client, 'cx-10', '2026-03-10', 'cancelled');
  await mark(client, 'cx-10', ADA, 'present');
  await mark(client, 'cx-10', BO, 'present');

  await addClass(client, 'held-11', '2026-03-11', 'open');
  await mark(client, 'held-11', ADA, 'present');

  await addClass(client, 'cx-12', '2026-03-12', 'cancelled');
  await addClass(client, 'held-12', '2026-03-12', 'open');
  await mark(client, 'cx-12', ADA, 'present');
  await mark(client, 'held-12', ADA, 'absent');

  await addClass(client, 'cx-13', '2026-03-13', 'cancelled');
  await mark(client, 'cx-13', ADA, 'present');
  await legacy(client, ADA, '2026-03-13', 'absent');

  await addClass(client, 'cx-14', '2026-03-14', 'cancelled');
  await mark(client, 'cx-14', ADA, 'absent');
  await activity(client, ADA, '2026-03-14', 'present');

  await activity(client, BO, '2026-03-15', 'present');
  await legacy(client, BO, '2026-03-16', 'late');

  await addClass(client, 'full-17', '2026-03-17', 'full');
  await mark(client, 'full-17', BO, 'present');
}

const row = (
  athlete_id: string,
  attendance_date: string,
  status: string,
  source: string,
  class_marks_that_day: number,
  contributing_sources: number,
): DayRow => ({ athlete_id, attendance_date, status, source, class_marks_that_day, contributing_sources });

const BEFORE: DayRow[] = [
  row(ADA, '2026-03-10', 'present', 'scheduler_attendance', 1, 1),
  row(ADA, '2026-03-11', 'present', 'scheduler_attendance', 1, 1),
  row(ADA, '2026-03-12', 'present', 'scheduler_attendance', 2, 1),
  row(ADA, '2026-03-13', 'present', 'scheduler_attendance', 1, 2),
  row(ADA, '2026-03-14', 'present', 'activity_log', 0, 2),
  row(BO, '2026-03-10', 'present', 'scheduler_attendance', 1, 1),
  row(BO, '2026-03-15', 'present', 'activity_log', 0, 1),
  row(BO, '2026-03-16', 'present', 'attendance', 0, 1),
  row(BO, '2026-03-17', 'present', 'scheduler_attendance', 1, 1),
];

const AFTER: DayRow[] = [
  row(ADA, '2026-03-11', 'present', 'scheduler_attendance', 1, 1),
  row(ADA, '2026-03-12', 'absent', 'scheduler_attendance', 1, 1),
  row(ADA, '2026-03-13', 'absent', 'attendance', 0, 1),
  row(ADA, '2026-03-14', 'present', 'activity_log', 0, 1),
  row(BO, '2026-03-15', 'present', 'activity_log', 0, 1),
  row(BO, '2026-03-16', 'present', 'attendance', 0, 1),
  row(BO, '2026-03-17', 'present', 'scheduler_attendance', 1, 1),
];

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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  activityLogSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_activity_log_migration.sql'), 'utf8');
  precedenceSql = await fs.readFile(path.join(INFRA_DIR, PRECEDENCE_FILE), 'utf8');
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

describe('the migration, over the view attendance-precedence left', () => {
  test('a cancelled class stops counting; held classes, activity_log and legacy days stay; no row is touched', async () => {
    const { apply } = await runner();
    const client = await precedenceDatabase('arc_scenario');
    try {
      await seedScenario(client);

      // The view as it stands counts the cancelled classes (the negative control).
      expect(await viewRows(client)).toEqual(BEFORE);

      const tables = [
        ['pilot.scheduler_attendance', 'attendance_id'],
        ['pilot.scheduler_classes', 'class_id'],
        ['pilot.activity_log', 'activity_id'],
        ['pilot.attendance', 'attendance_id'],
      ] as const;
      const tablesBefore = await Promise.all(tables.map(([table, key]) => tableRows(client, table, key)));
      const registerCount = (await client.query('select count(*)::int as n from pilot.scheduler_attendance')).rows[0].n;
      expect(registerCount).toBe(8);

      const sql = await migration();
      await apply(client, sql);
      // The `all` chain re-runs every migration on every dispatch.
      await apply(client, sql);

      expect(await viewRows(client)).toEqual(AFTER);

      // Days no cancelled class touched are the same rows they were.
      const untouched = (rows: DayRow[]) =>
        rows.filter((r) => !['2026-03-10', '2026-03-12', '2026-03-13', '2026-03-14'].includes(r.attendance_date));
      expect(untouched(await viewRows(client))).toEqual(untouched(BEFORE));

      // Every row of every source table, including all eight register marks, is unchanged.
      expect(await Promise.all(tables.map(([table, key]) => tableRows(client, table, key)))).toEqual(tablesBefore);
    } finally {
      await client.end();
    }
  });

  test('the columns and the rest of the definition are unchanged; the comment says it; un-cancelling brings the marks back', async () => {
    const { apply, filterText } = await runner();
    const client = await precedenceDatabase('arc_shape');
    try {
      await seedScenario(client);
      const shapeBefore = await viewShape(client);
      const definitionBefore = await viewDefinition(client);
      expect(definitionBefore).not.toContain('cancelled');

      await apply(client, await migration());

      expect(await viewShape(client)).toEqual(shapeBefore);
      expect(shapeBefore).toEqual([
        'organization_id text',
        'athlete_id text',
        'attendance_date date',
        'status text',
        'source text',
        'class_marks_that_day integer',
        'contributing_sources integer',
      ]);
      // The stored text the runner's readiness looks for is one new line, on the class-marks
      // branch, and every other line of the stored definition is the line it was.
      const definitionAfter = await viewDefinition(client);
      const beforeLines = definitionBefore.split('\n');
      const added = definitionAfter.split('\n').filter((line) => !beforeLines.includes(line));
      expect(added.map((line) => line.trim())).toEqual([`WHERE (${filterText})`]);
      expect(definitionAfter.split('\n').filter((line) => line !== added[0]).join('\n')).toBe(definitionBefore);
      expect(definitionAfter.indexOf(added[0])).toBeGreaterThan(definitionAfter.indexOf('JOIN pilot.scheduler_classes sc'));
      expect(definitionAfter.indexOf(added[0])).toBeLessThan(definitionAfter.indexOf('FROM pilot.attendance a'));

      const comment = await client.query(
        `select obj_description('pilot.attendance_reconciled'::regclass, 'pg_class') as c`,
      );
      expect(comment.rows[0].c).toMatch(/^CT-13 system of record for athlete-day participation\./);
      expect(comment.rows[0].c).toContain("scheduler_classes.status = 'cancelled'");

      // The marks were kept, so a class put back to open counts again at once.
      await client.query(`update pilot.scheduler_classes set status = 'open' where class_id = 'cx-10'`);
      const back = (await viewRows(client)).filter((r) => r.attendance_date === '2026-03-10');
      expect(back).toEqual([
        row(ADA, '2026-03-10', 'present', 'scheduler_attendance', 1, 1),
        row(BO, '2026-03-10', 'present', 'scheduler_attendance', 1, 1),
      ]);
    } finally {
      await client.end();
    }
  });

  test('the file holds nothing that writes, alters or removes a table', async () => {
    const sql = (await migration())
      .split('\n')
      .filter((line) => !/^\s*--/.test(line))
      .join('\n');
    expect(sql).toMatch(/create\s+or\s+replace\s+view\s+pilot\.attendance_reconciled\s+as/i);
    expect(sql).not.toMatch(/\b(drop|truncate|delete|insert|update|alter|grant|revoke)\b/i);
  });
});

describe("the runner's readiness refuses a result it did not produce", () => {
  test('a database the migration never reached', async () => {
    const { apply } = await runner();
    const client = await precedenceDatabase('arc_never_ran');
    try {
      await expect(apply(client, 'select 1')).rejects.toThrow(
        /^ATTENDANCE_RECONCILED_CANCELLED_NOT_READY: cancelled_filter_ready$/,
      );
    } finally {
      await client.end();
    }
  });

  test('the old definition passed off as this one, and a definition that drops a column', async () => {
    const { apply } = await runner();
    const client = await precedenceDatabase('arc_wrong_sql');
    try {
      await apply(client, await migration());
      await expect(apply(client, precedenceSql)).rejects.toThrow(/cancelled_filter_ready/);
      // Rolled back: the view still has this migration's filter.
      expect(await viewDefinition(client)).toContain((await runner()).filterText);

      const narrower = `drop view pilot.attendance_reconciled;
        create view pilot.attendance_reconciled as
          select sa.organization_id, sa.athlete_id
            from pilot.scheduler_attendance sa join pilot.scheduler_classes sc
              on sc.organization_id = sa.organization_id and sc.class_id = sa.class_id
           where sc.status <> 'cancelled'`;
      await expect(apply(client, narrower)).rejects.toThrow(/columns_ready/);
      expect(await viewShape(client)).toHaveLength(7);
    } finally {
      await client.end();
    }
  });

  test('a database with no view to replace is refused by name, before the file runs', async () => {
    const { apply } = await runner();
    const client = await emptyDatabase('arc_no_view');
    try {
      await client.query(baseSchemaSql);
      await expect(apply(client, await migration())).rejects.toThrow(
        /^ATTENDANCE_RECONCILED_CANCELLED_NOT_READY: view_present \(apply scheduler-tables and attendance-precedence first\)$/,
      );
      const view = await client.query(`select to_regclass('pilot.attendance_reconciled') as v`);
      expect(view.rows[0].v).toBeNull();
    } finally {
      await client.end();
    }
  });
});

describe('the readers, on the schema production runs (every migration in the `all` order)', () => {
  /* Fails on main: the view there still reads the cancelled class. Built with
     the full-schema helper rather than this file's runner, so it says what a
     database that ran `all` returns. */
  test('coach/attendance-today, the 28-day window, training days and the gap queue skip a cancelled class', async () => {
    const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
    const applyFullSchema = fullSchema.applyFullSchema as (c: Client, o?: { infraDir?: string }) => Promise<unknown>;
    const client = await emptyDatabase('arc_readers');
    activeClient = client;
    try {
      await applyFullSchema(client, { infraDir: INFRA_DIR });
      await seedGym(client);

      const today = gymDayIso(new Date()) as string;
      const daysAgo = async (n: number) =>
        (await client.query<{ d: string }>(`select ($1::date - $2::int)::text as d`, [today, n])).rows[0].d;

      // Today: ADA marked present in a class that was then cancelled; BO present in a held class.
      await addClass(client, 'cx-today', today, 'cancelled');
      await mark(client, 'cx-today', ADA, 'present');
      await addClass(client, 'held-today', today, 'open');
      await mark(client, 'held-today', BO, 'present');
      // Three days ago ADA was present in a held class; five days ago, absent in a held class.
      const three = await daysAgo(3);
      const five = await daysAgo(5);
      await addClass(client, 'held-3', three, 'open');
      await mark(client, 'held-3', ADA, 'present');
      await addClass(client, 'held-5', five, 'open');
      await mark(client, 'held-5', ADA, 'absent');
      // Two days ago, a cancelled class with ADA present.
      const two = await daysAgo(2);
      await addClass(client, 'cx-2', two, 'cancelled');
      await mark(client, 'cx-2', ADA, 'present');

      // coach/attendance-today reads attendanceOnDay for the gym's today.
      expect(await attendanceOnDay(ORG, [ADA, BO], today)).toEqual([
        { athlete_id: BO, status: 'present', source: 'scheduler_attendance' },
      ]);

      // coach/athlete-attendance and analytics/performance read the 28-day window.
      const window = (await getAttendanceLast28Days(ORG, [ADA], today)).get(ADA);
      expect(window).toMatchObject({
        days_present: 1,
        days_absent: 1,
        attendance_rate: 0.5,
        last_present_day: three,
        days_since_last_present: 3,
      });

      // Training days (coachIntelligence.ts, progressionSuggestions.ts read this rollup).
      const rollup = await getPerformanceRollup(ORG, [ADA], 28);
      expect(rollup).toHaveLength(1);
      expect(rollup[0]).toMatchObject({ training_days: 1, training_days_recorded: 2 });

      // The passbook gap queue's last visit.
      await client.query(
        `insert into pilot.progression_gaps
           (gap_id, organization_id, athlete_id, coach_account_id, gap_type, gap_description,
            severity, detected_from)
         values ('gap-arc', $1, $2, $3, 'technique', 'ARC gap', 'medium', 'attendance')`,
        [ORG, ADA, COACH],
      );
      const queue = await getCoachPassbookGapQueue(ORG, [ADA]);
      expect(queue).toHaveLength(1);
      expect(queue[0]).toMatchObject({ last_attended_on: three, recorded_absences_since_last_visit: 0 });

      // And every mark is still in the register for staff.
      const register = await client.query(
        `select class_id from pilot.scheduler_attendance where organization_id = $1 order by class_id`,
        [ORG],
      );
      expect(register.rows.map((r) => r.class_id)).toEqual(['cx-2', 'cx-today', 'held-3', 'held-5', 'held-today']);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
