// Real PostgreSQL test for the weekly session-load read behind the coach's
// "Training load jumped" suggestion (weeklySessionLoad.ts, Rule 6).
//
// What needs proving that reading the SQL or a mocked query cannot:
//
//   * the week bucketing: (gym today - date) / 7 puts the last 7 days, today
//     included, in week 0, and the window ends exactly after week 4 --
//     future-dated rows and rows 35+ days back are left out;
//   * the gym time zone edge: with the server in UTC (as Azure is), an evening
//     in Punxsutawney is already tomorrow in UTC, and the window must still
//     follow the GYM's day;
//   * the provenance filter: only athlete post-session self-reports with both
//     RPE and minutes are summed;
//   * the end-to-end ratio on real rows through readLoadJumps (CORE-13);
//   * lane R6-b2: what a week's attended / rated / rest-marked counts are on
//     real rows (session rows, the reconciled register view, rest marks), and
//     that loadWeekWindows (the coach's strip) is the same 7-day bucketing as
//     this module's SQL.
//
// Built on the FULL production schema (scripts/lib/full-schema.mjs, in the
// workflow's `all` order), once, as a template database each test copies:
// the coverage read needs the register view and pilot.athlete_rest_marks.
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

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
}));

import { loadWeekWindows } from './restMarks';
import { getWeeklyLoadCoverage, getWeeklySessionLoads, readLoadJumps, readLoadWeekCoverage } from './weeklySessionLoad';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-weekly-load-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const TEMPLATE_DB = 'weekly_load_template';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-weekly-load';
const OTHER_ORG_ID = 'org-weekly-load-other';
const COACH_ID = 'acct-weekly-load-coach';
const ATHLETE_ID = 'ath-weekly-load-1';
const OTHER_ATHLETE_ID = 'ath-weekly-load-2';
const SELF_REPORT = 'athlete_post_session_self_report';

// A fixed gym day far from the day this suite runs, on purpose: with a date
// near "now", a query that wrongly used the server's current_date would agree
// with the pinned instant by luck and pass. (It did, once: the first draft used
// the day it was written.) Mid-January keeps clear of daylight-saving changes.
// Noon in Punxsutawney on 2025-01-15 (EST, UTC-5).
const GYM_NOON = new Date('2025-01-15T17:00:00Z');
// 10:30pm in Punxsutawney on 2025-01-15 -- already 2025-01-16 in UTC.
const GYM_EVENING = new Date('2025-01-16T03:30:00Z');

/** The gym calendar date `days` before 2025-01-15 (negative = after). */
function gymDaysBefore(days: number): string {
  const base = Date.UTC(2025, 0, 15);
  return new Date(base - days * 86_400_000).toISOString().slice(0, 10);
}

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let sessionSeq = 0;

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

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name} template ${TEMPLATE_DB}`);
  await admin.end();

  const db = new Client({ connectionString: connectionStringFor(name) });
  await db.connect();
  // Azure Database for PostgreSQL runs in UTC; pin it so the time zone edge
  // below is tested against the server zone production actually has.
  await db.query(`set time zone 'UTC'`);
  for (const orgId of [ORG_ID, OTHER_ORG_ID]) {
    await db.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
  }
  await db.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  for (const [orgId, athleteId] of [[ORG_ID, ATHLETE_ID], [ORG_ID, OTHER_ATHLETE_ID], [OTHER_ORG_ID, ATHLETE_ID]]) {
    await db.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, 'Load Athlete', '2000-01-01', '75', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [orgId, athleteId, COACH_ID],
    );
  }
  return db;
}

async function addSession(values: {
  date: string;
  rpe: number | null;
  minutes: number | null;
  method?: string;
  athleteId?: string;
  orgId?: string;
  completed?: boolean;
}) {
  sessionSeq += 1;
  await client.query(
    `insert into pilot.sessions
       (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag, created_at, updated_at, duration_minutes)
     values ($1, $2, $3, $4::date, $5, $6, 'n', $8, now(), now(), $7)`,
    [
      values.orgId ?? ORG_ID,
      `sess-${sessionSeq}`,
      values.athleteId ?? ATHLETE_ID,
      values.date,
      values.rpe,
      values.method ?? (values.rpe == null ? 'UNKNOWN' : SELF_REPORT),
      values.minutes,
      values.completed ?? true,
    ],
  );
}

/** A register mark in the legacy table, which the reconciled view reads. */
async function addRegister(date: string, status: string, athleteId = ATHLETE_ID, orgId = ORG_ID) {
  await client.query(
    `insert into pilot.attendance (organization_id, attendance_id, athlete_id, attendance_date, status)
     values ($1, gen_random_uuid(), $2, $3::date, $4)`,
    [orgId, athleteId, date, status],
  );
}

async function addMark(firstDay: string, lastDay: string, options: { cleared?: boolean; athleteId?: string; orgId?: string } = {}) {
  await client.query(
    `insert into pilot.athlete_rest_marks
       (organization_id, mark_id, athlete_id, kind, first_day, last_day, marked_by_account_id, marked_by_role,
        cleared_at, cleared_by_account_id)
     values ($1, gen_random_uuid(), $2, 'rest', $3::date, $4::date, $5, 'coach', $6, $7)`,
    [
      options.orgId ?? ORG_ID,
      options.athleteId ?? ATHLETE_ID,
      firstDay,
      lastDay,
      COACH_ID,
      options.cleared ? new Date() : null,
      options.cleared ? COACH_ID : null,
    ],
  );
}

function byWeek(rows: Awaited<ReturnType<typeof getWeeklySessionLoads>>, athleteId = ATHLETE_ID) {
  return Object.fromEntries(
    rows
      .filter((row) => row.athlete_id === athleteId)
      .map((row) => [row.week_index, Number(row.week_load)]),
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

  // The full production schema, once, as a template every test copies.
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  const applyFullSchema = fullSchema.applyFullSchema as (db: Client, opts?: { infraDir?: string }) => Promise<unknown>;
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEMPLATE_DB}`);
  await admin.query(`create database ${TEMPLATE_DB}`);
  await admin.end();
  const template = new Client({ connectionString: connectionStringFor(TEMPLATE_DB) });
  await template.connect();
  try {
    await applyFullSchema(template, { infraDir: INFRA_DIR });
  } finally {
    await template.end();
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
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

beforeEach(async () => {
  client = await freshDatabase(`weekly_load_${sessionSeq + 1}`);
  activeClient = client;
});

afterEach(async () => {
  activeClient = null;
  await client.end();
});

describe('weekly session load on real Postgres', () => {
  test('week 0 is the last 7 gym days, today included; the window ends after week 4', async () => {
    await addSession({ date: gymDaysBefore(-1), rpe: 9, minutes: 100 }); // future: left out
    await addSession({ date: gymDaysBefore(0), rpe: 5, minutes: 60 }); // today: week 0
    await addSession({ date: gymDaysBefore(6), rpe: 4, minutes: 50 }); // 6 days back: week 0
    await addSession({ date: gymDaysBefore(7), rpe: 3, minutes: 40 }); // 7 days back: week 1
    await addSession({ date: gymDaysBefore(34), rpe: 2, minutes: 30 }); // 34 days back: week 4
    await addSession({ date: gymDaysBefore(35), rpe: 9, minutes: 100 }); // 35 days back: left out

    const rows = await getWeeklySessionLoads(ORG_ID, [ATHLETE_ID], GYM_NOON);
    expect(byWeek(rows)).toEqual({ 0: 300 + 200, 1: 120, 4: 60 });
    expect(rows.find((row) => row.week_index === 0)?.session_count).toBe(2);
    // The under-18 family wording's minutes: the same sessions, summed.
    expect(rows.find((row) => row.week_index === 0)?.week_minutes).toBe(60 + 50);
    expect(rows.find((row) => row.week_index === 4)?.week_minutes).toBe(30);
  });

  test('a gym evening follows the gym day even though the UTC server is already on tomorrow', async () => {
    const { rows: [clock] } = await client.query<{ utc_date: string; gym_date: string }>(
      `select ($1::timestamptz)::date::text as utc_date,
              ($1::timestamptz at time zone 'America/New_York')::date::text as gym_date`,
      [GYM_EVENING.toISOString()],
    );
    expect(clock).toEqual({ utc_date: '2025-01-16', gym_date: '2025-01-15' });

    await addSession({ date: gymDaysBefore(6), rpe: 4, minutes: 50 }); // 6 gym days back: week 0
    await addSession({ date: gymDaysBefore(-1), rpe: 9, minutes: 100 }); // tomorrow in the gym: left out

    const rows = await getWeeklySessionLoads(ORG_ID, [ATHLETE_ID], GYM_EVENING);
    expect(byWeek(rows)).toEqual({ 0: 200 });
  });

  test('only athlete post-session self-reports with both RPE and minutes are summed', async () => {
    await addSession({ date: gymDaysBefore(1), rpe: 5, minutes: 60 }); // counts: 300
    await addSession({ date: gymDaysBefore(1), rpe: 8, minutes: 90, method: 'UNKNOWN' }); // readiness slider era
    await addSession({ date: gymDaysBefore(1), rpe: 6, minutes: null }); // no minutes
    // (A self-report with no rating cannot exist: the rpe-semantics migration's
    // pilot_sessions_rpe_method_agrees_with_value check refuses it.)

    const rows = await getWeeklySessionLoads(ORG_ID, [ATHLETE_ID], GYM_NOON);
    expect(byWeek(rows)).toEqual({ 0: 300 });
    expect(rows[0].session_count).toBe(1);
  });

  test('scoped to the organization and to the athletes asked for', async () => {
    await addSession({ date: gymDaysBefore(1), rpe: 5, minutes: 60 });
    await addSession({ date: gymDaysBefore(1), rpe: 9, minutes: 100, orgId: OTHER_ORG_ID });
    await addSession({ date: gymDaysBefore(1), rpe: 9, minutes: 100, athleteId: OTHER_ATHLETE_ID });

    const rows = await getWeeklySessionLoads(ORG_ID, [ATHLETE_ID], GYM_NOON);
    expect(rows.map((row) => [row.athlete_id, Number(row.week_load)])).toEqual([[ATHLETE_ID, 300]]);
  });

  test('real rows through readLoadJumps: a doubled week reads 2.0 against the usual week', async () => {
    await addSession({ date: gymDaysBefore(2), rpe: 5, minutes: 100 }); // week 0: 500
    await addSession({ date: gymDaysBefore(1), rpe: 5, minutes: 100 }); // week 0: 500
    await addSession({ date: gymDaysBefore(9), rpe: 5, minutes: 100 }); // week 1: 500
    await addSession({ date: gymDaysBefore(16), rpe: 5, minutes: 100 }); // week 2: 500
    await addSession({ date: gymDaysBefore(23), rpe: 5, minutes: 100 }); // week 3: 500

    const rows = await getWeeklySessionLoads(ORG_ID, [ATHLETE_ID], GYM_NOON);
    const coverage = await getWeeklyLoadCoverage(ORG_ID, [ATHLETE_ID], GYM_NOON);
    expect(readLoadJumps(ORG_ID, rows, coverage)).toEqual([
      {
        athlete_id: ATHLETE_ID,
        acute_load: 1000,
        usual_weekly_load: 500,
        ratio: 2,
        prior_weeks_with_load: 3,
      },
    ]);
  });
});

describe('getWeeklyLoadCoverage on real rows (lane R6-b2)', () => {
  function statusOf(rows: Awaited<ReturnType<typeof getWeeklyLoadCoverage>>, athleteId = ATHLETE_ID) {
    return readLoadWeekCoverage(rows, athleteId).map((week) => [week.week_index, week.attended, week.rated, week.marked_days, week.status]);
  }

  test('one row per week for every athlete named, zeros included: nothing logged reads as not logged', async () => {
    const rows = await getWeeklyLoadCoverage(ORG_ID, [ATHLETE_ID, OTHER_ATHLETE_ID], GYM_NOON);
    expect(rows).toHaveLength(10);
    expect(statusOf(rows, OTHER_ATHLETE_ID)).toEqual([
      [0, 0, 0, 0, 'not_logged'], [1, 0, 0, 0, 'not_logged'], [2, 0, 0, 0, 'not_logged'],
      [3, 0, 0, 0, 'not_logged'], [4, 0, 0, 0, 'not_logged'],
    ]);
  });

  test('attended = session rows plus register-only days; rated = the sessions Rule 6 counts', async () => {
    // Week 0: two rated, one checked out without a rating, one register-only day.
    await addSession({ date: gymDaysBefore(0), rpe: 6, minutes: 60 });
    await addSession({ date: gymDaysBefore(2), rpe: 6, minutes: 60 });
    await addSession({ date: gymDaysBefore(3), rpe: null, minutes: null });
    await addRegister(gymDaysBefore(4), 'present');
    // A register day that already has a session row is that session, not another.
    await addRegister(gymDaysBefore(2), 'present');
    // Absent and excused register days are not attendance.
    await addRegister(gymDaysBefore(5), 'absent');
    await addRegister(gymDaysBefore(6), 'excused');
    // Week 1: rated, but an UNKNOWN-method rating is not Rule 6's.
    await addSession({ date: gymDaysBefore(8), rpe: 5, minutes: 60 });
    await addSession({ date: gymDaysBefore(9), rpe: 5, minutes: 60, method: 'UNKNOWN' });
    // Another gym's rows for the same athlete id never count here.
    await addSession({ date: gymDaysBefore(1), rpe: 9, minutes: 90, orgId: OTHER_ORG_ID });
    await addRegister(gymDaysBefore(1), 'present', ATHLETE_ID, OTHER_ORG_ID);

    const rows = await getWeeklyLoadCoverage(ORG_ID, [ATHLETE_ID], GYM_NOON);
    expect(statusOf(rows).slice(0, 2)).toEqual([
      [0, 4, 2, 0, 'partly_logged'],
      [1, 2, 1, 0, 'partly_logged'],
    ]);
  });

  test("an open session dated today is not counted yet; a finished one is", async () => {
    await addSession({ date: gymDaysBefore(1), rpe: 6, minutes: 60 });
    await addSession({ date: gymDaysBefore(0), rpe: null, minutes: null, completed: false });
    await addRegister(gymDaysBefore(0), 'present');
    let rows = await getWeeklyLoadCoverage(ORG_ID, [ATHLETE_ID], GYM_NOON);
    expect(statusOf(rows)[0]).toEqual([0, 1, 1, 0, 'logged']);

    // The same open row dated yesterday is a session that was never closed: counted, unrated.
    await addSession({ date: gymDaysBefore(2), rpe: null, minutes: null, completed: false });
    rows = await getWeeklyLoadCoverage(ORG_ID, [ATHLETE_ID], GYM_NOON);
    expect(statusOf(rows)[0]).toEqual([0, 2, 1, 0, 'partly_logged']);
  });

  test('rest marks: live marks count their days in each week; a cleared mark and another athlete do not', async () => {
    // Days 7..20 back: all of week 1 (7..13) and all of week 2 (14..20).
    await addMark(gymDaysBefore(20), gymDaysBefore(7));
    // Straddles weeks 3 and 4: days 26..29.
    await addMark(gymDaysBefore(29), gymDaysBefore(26));
    // Overlapping marks count a day once.
    await addMark(gymDaysBefore(8), gymDaysBefore(7));
    await addMark(gymDaysBefore(1), gymDaysBefore(0), { cleared: true });
    await addMark(gymDaysBefore(1), gymDaysBefore(0), { athleteId: OTHER_ATHLETE_ID });
    // Ahead of today: not in any week.
    await addMark(gymDaysBefore(-3), gymDaysBefore(-5));

    const rows = await getWeeklyLoadCoverage(ORG_ID, [ATHLETE_ID], GYM_NOON);
    expect(statusOf(rows)).toEqual([
      [0, 0, 0, 0, 'not_logged'],
      [1, 0, 0, 7, 'rest_marked'],
      [2, 0, 0, 7, 'rest_marked'],
      [3, 0, 0, 2, 'rest_marked'],
      [4, 0, 0, 2, 'rest_marked'],
    ]);
  });

  test('a rest mark on a week the athlete attended does not hide the sessions', async () => {
    await addMark(gymDaysBefore(6), gymDaysBefore(0));
    await addSession({ date: gymDaysBefore(2), rpe: 6, minutes: 60 });
    const rows = await getWeeklyLoadCoverage(ORG_ID, [ATHLETE_ID], GYM_NOON);
    expect(statusOf(rows)[0]).toEqual([0, 1, 1, 7, 'logged']);
  });

  test('the gym evening edge: the coverage weeks follow the GYM day, as the load does', async () => {
    // At 10:30pm on the 15th in Punxsutawney it is already the 16th in UTC;
    // the gym's day is still the 15th, so the 16th is in the future.
    await addSession({ date: gymDaysBefore(-1), rpe: 6, minutes: 60 }); // the 16th: future at the gym
    await addSession({ date: gymDaysBefore(6), rpe: 6, minutes: 60 }); // the 9th: still week 0
    const rows = await getWeeklyLoadCoverage(ORG_ID, [ATHLETE_ID], GYM_EVENING);
    expect(statusOf(rows)[0]).toEqual([0, 1, 1, 0, 'logged']);
  });

  test("loadWeekWindows (the coach's strip) is exactly this module's SQL bucketing, on every day of the window", async () => {
    // One rated session on each of the 36 days around the window.
    for (let day = -1; day <= 35; day += 1) await addSession({ date: gymDaysBefore(day), rpe: 1, minutes: day + 2 });
    const loads = await getWeeklySessionLoads(ORG_ID, [ATHLETE_ID], GYM_NOON);
    const coverage = await getWeeklyLoadCoverage(ORG_ID, [ATHLETE_ID], GYM_NOON);
    const windows = loadWeekWindows(gymDaysBefore(0));
    for (const window of windows) {
      let expectedLoad = 0;
      let expectedSessions = 0;
      for (let day = 0; day <= 35; day += 1) {
        const iso = gymDaysBefore(day);
        if (iso >= window.first_day && iso <= window.last_day) {
          expectedLoad += day + 2;
          expectedSessions += 1;
        }
      }
      const load = loads.find((row) => row.week_index === window.week_index);
      expect([window.week_index, Number(load?.week_load), Number(load?.session_count)]).toEqual([window.week_index, expectedLoad, expectedSessions]);
      const cover = coverage.find((row) => row.week_index === window.week_index);
      expect([window.week_index, Number(cover?.attended)]).toEqual([window.week_index, 7]);
    }
    expect(loads.map((row) => row.week_index).sort()).toEqual([0, 1, 2, 3, 4]);
  });

  test('real rows, a break: 1 logged week, 2 marked rest weeks, a heavy week back speaks', async () => {
    await addSession({ date: gymDaysBefore(1), rpe: 5, minutes: 100 }); // week 0: 500
    await addSession({ date: gymDaysBefore(2), rpe: 5, minutes: 100 }); // week 0: 500
    await addMark(gymDaysBefore(20), gymDaysBefore(7)); // weeks 1 and 2 rest
    await addSession({ date: gymDaysBefore(23), rpe: 5, minutes: 100 }); // week 3: 500
    const rows = await getWeeklySessionLoads(ORG_ID, [ATHLETE_ID], GYM_NOON);
    const coverage = await getWeeklyLoadCoverage(ORG_ID, [ATHLETE_ID], GYM_NOON);
    expect(readLoadJumps(ORG_ID, rows, coverage)).toEqual([
      { athlete_id: ATHLETE_ID, acute_load: 1000, usual_weekly_load: 500 / 3, ratio: 6, prior_weeks_with_load: 3 },
    ]);
  });
});
