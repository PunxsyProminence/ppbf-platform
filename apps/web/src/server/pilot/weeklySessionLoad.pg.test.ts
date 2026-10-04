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
//   * the end-to-end ratio on real rows through readLoadJumps (CORE-13).
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

import { Client } from 'pg';

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
}));

import { getWeeklySessionLoads, readLoadJumps } from './weeklySessionLoad';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-weekly-load-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

// The order the `all` chain runs them; pilot.sessions gains rpe_method and
// then duration_minutes.
const MIGRATIONS = [
  'pilot_slice_postgres_progression_migration.sql',
  'pilot_slice_postgres_activity_log_migration.sql',
  'pilot_slice_postgres_readiness_provenance_migration.sql',
  'pilot_slice_postgres_session_rpe_semantics_migration.sql',
  'pilot_slice_postgres_session_duration_migration.sql',
];

const ORG_ID = 'org-weekly-load';
const OTHER_ORG_ID = 'org-weekly-load-other';
const COACH_ID = 'acct-weekly-load-coach';
const ATHLETE_ID = 'ath-weekly-load-1';
const OTHER_ATHLETE_ID = 'ath-weekly-load-2';
const SELF_REPORT = 'athlete_post_session_self_report';

// Noon in Punxsutawney on Sunday 2026-10-04 (EDT, UTC-4).
const GYM_NOON_OCT_4 = new Date('2026-10-04T16:00:00Z');
// 10:30pm in Punxsutawney on 2026-10-04 -- already 2026-10-05 in UTC.
const GYM_EVENING_OCT_4 = new Date('2026-10-05T02:30:00Z');

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let migrationSql: string[];
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
  await admin.query(`create database ${name}`);
  await admin.end();

  const db = new Client({ connectionString: connectionStringFor(name) });
  await db.connect();
  // Azure Database for PostgreSQL runs in UTC; pin it so the time zone edge
  // below is tested against the server zone production actually has.
  await db.query(`set time zone 'UTC'`);
  await db.query(baseSchemaSql);
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
  for (const sql of migrationSql) {
    await db.query(sql);
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
}) {
  sessionSeq += 1;
  await client.query(
    `insert into pilot.sessions
       (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag, created_at, updated_at, duration_minutes)
     values ($1, $2, $3, $4::date, $5, $6, 'n', true, now(), now(), $7)`,
    [
      values.orgId ?? ORG_ID,
      `sess-${sessionSeq}`,
      values.athleteId ?? ATHLETE_ID,
      values.date,
      values.rpe,
      values.method ?? SELF_REPORT,
      values.minutes,
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  migrationSql = await Promise.all(MIGRATIONS.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')));
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
    await addSession({ date: '2026-10-05', rpe: 9, minutes: 100 }); // future: left out
    await addSession({ date: '2026-10-04', rpe: 5, minutes: 60 }); // today: week 0
    await addSession({ date: '2026-09-28', rpe: 4, minutes: 50 }); // 6 days back: week 0
    await addSession({ date: '2026-09-27', rpe: 3, minutes: 40 }); // 7 days back: week 1
    await addSession({ date: '2026-08-31', rpe: 2, minutes: 30 }); // 34 days back: week 4
    await addSession({ date: '2026-08-30', rpe: 9, minutes: 100 }); // 35 days back: left out

    const rows = await getWeeklySessionLoads(ORG_ID, [ATHLETE_ID], GYM_NOON_OCT_4);
    expect(byWeek(rows)).toEqual({ 0: 300 + 200, 1: 120, 4: 60 });
    expect(rows.find((row) => row.week_index === 0)?.session_count).toBe(2);
  });

  test('a gym evening follows the gym day even though the UTC server is already on tomorrow', async () => {
    const { rows: [clock] } = await client.query<{ utc_date: string; gym_date: string }>(
      `select ($1::timestamptz)::date::text as utc_date,
              ($1::timestamptz at time zone 'America/New_York')::date::text as gym_date`,
      [GYM_EVENING_OCT_4.toISOString()],
    );
    expect(clock).toEqual({ utc_date: '2026-10-05', gym_date: '2026-10-04' });

    await addSession({ date: '2026-09-28', rpe: 4, minutes: 50 }); // 6 gym days back: week 0
    await addSession({ date: '2026-10-05', rpe: 9, minutes: 100 }); // tomorrow in the gym: left out

    const rows = await getWeeklySessionLoads(ORG_ID, [ATHLETE_ID], GYM_EVENING_OCT_4);
    expect(byWeek(rows)).toEqual({ 0: 200 });
  });

  test('only athlete post-session self-reports with both RPE and minutes are summed', async () => {
    await addSession({ date: '2026-10-03', rpe: 5, minutes: 60 }); // counts: 300
    await addSession({ date: '2026-10-03', rpe: 8, minutes: 90, method: 'UNKNOWN' }); // readiness slider era
    await addSession({ date: '2026-10-03', rpe: 6, minutes: null }); // no minutes
    // (A self-report with no rating cannot exist: the rpe-semantics migration's
    // pilot_sessions_rpe_method_agrees_with_value check refuses it.)

    const rows = await getWeeklySessionLoads(ORG_ID, [ATHLETE_ID], GYM_NOON_OCT_4);
    expect(byWeek(rows)).toEqual({ 0: 300 });
    expect(rows[0].session_count).toBe(1);
  });

  test('scoped to the organization and to the athletes asked for', async () => {
    await addSession({ date: '2026-10-03', rpe: 5, minutes: 60 });
    await addSession({ date: '2026-10-03', rpe: 9, minutes: 100, orgId: OTHER_ORG_ID });
    await addSession({ date: '2026-10-03', rpe: 9, minutes: 100, athleteId: OTHER_ATHLETE_ID });

    const rows = await getWeeklySessionLoads(ORG_ID, [ATHLETE_ID], GYM_NOON_OCT_4);
    expect(rows.map((row) => [row.athlete_id, Number(row.week_load)])).toEqual([[ATHLETE_ID, 300]]);
  });

  test('real rows through readLoadJumps: a doubled week reads 2.0 against the usual week', async () => {
    await addSession({ date: '2026-10-02', rpe: 5, minutes: 100 }); // week 0: 500
    await addSession({ date: '2026-10-03', rpe: 5, minutes: 100 }); // week 0: 500
    await addSession({ date: '2026-09-25', rpe: 5, minutes: 100 }); // week 1: 500
    await addSession({ date: '2026-09-18', rpe: 5, minutes: 100 }); // week 2: 500
    await addSession({ date: '2026-09-11', rpe: 5, minutes: 100 }); // week 3: 500

    const rows = await getWeeklySessionLoads(ORG_ID, [ATHLETE_ID], GYM_NOON_OCT_4);
    expect(readLoadJumps(ORG_ID, rows)).toEqual([
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
