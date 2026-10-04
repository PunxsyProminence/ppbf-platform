// Real PostgreSQL test for the check-in wellness read behind the coach's
// "Load up, wellness down" suggestion (wellnessTrend.ts, Rule 7).
//
// What needs proving that reading the SQL or a mocked query cannot:
//
//   * the windows: the last 7 gym days (today included) against the 28 days
//     before, exactly the load read's weeks; future-dated rows and rows 35+
//     days back are left out;
//   * the gym time zone edge: with the server in UTC (as Azure is), an evening
//     in Punxsutawney is already tomorrow in UTC, and the window must still
//     follow the GYM's day;
//   * a skipped answer (null) is left out of both the average and the count;
//   * organization and athlete scoping;
//   * the end-to-end read through readWellnessDeclines.
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

import { getWellnessWindows, readWellnessDeclines } from './wellnessTrend';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-wellness-trend-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

// Base check-in table (energy, soreness, focus live there).
const MIGRATIONS = ['pilot_slice_postgres_athlete_check_ins_migration.sql'];

const ORG_ID = 'org-wellness-trend';
const OTHER_ORG_ID = 'org-wellness-trend-other';
const COACH_ID = 'acct-wellness-trend-coach';
const ATHLETE_ID = 'ath-wellness-trend-1';
const OTHER_ATHLETE_ID = 'ath-wellness-trend-2';

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
let baseSchemaSql: string;
let migrationSql: string[];
let client: Client;
let checkInSeq = 0;

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
       values ($1, $2, 'Wellness Athlete', '2000-01-01', '75', 'active', 'contact', true, $3, now(), now())
       on conflict do nothing`,
      [orgId, athleteId, COACH_ID],
    );
  }
  for (const sql of migrationSql) {
    await db.query(sql);
  }
  return db;
}

async function addCheckIn(values: {
  date: string;
  energy: number | null;
  soreness: number | null;
  athleteId?: string;
  orgId?: string;
}) {
  checkInSeq += 1;
  await client.query(
    `insert into pilot.athlete_check_ins
       (organization_id, check_in_id, athlete_id, checked_in_on, energy, soreness)
     values ($1, $2, $3, $4::date, $5, $6)`,
    [
      values.orgId ?? ORG_ID,
      `chk-${checkInSeq}`,
      values.athleteId ?? ATHLETE_ID,
      values.date,
      values.energy,
      values.soreness,
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
  client = await freshDatabase(`wellness_trend_${checkInSeq + 1}`);
  activeClient = client;
});

afterEach(async () => {
  activeClient = null;
  await client.end();
});

describe('check-in wellness windows on real Postgres', () => {
  test('recent is the last 7 gym days, today included; prior is the 28 before; the rest is left out', async () => {
    await addCheckIn({ date: gymDaysBefore(-1), energy: 1, soreness: 5 }); // future: left out
    await addCheckIn({ date: gymDaysBefore(0), energy: 2, soreness: 4 }); // today: recent
    await addCheckIn({ date: gymDaysBefore(6), energy: 3, soreness: 3 }); // 6 days back: recent
    await addCheckIn({ date: gymDaysBefore(7), energy: 4, soreness: 2 }); // 7 days back: prior
    await addCheckIn({ date: gymDaysBefore(34), energy: 5, soreness: 1 }); // 34 days back: prior
    await addCheckIn({ date: gymDaysBefore(35), energy: 1, soreness: 5 }); // 35 days back: left out

    const [row] = await getWellnessWindows(ORG_ID, [ATHLETE_ID], GYM_NOON);
    expect({
      energy_recent_avg: Number(row.energy_recent_avg),
      energy_recent_count: row.energy_recent_count,
      energy_prior_avg: Number(row.energy_prior_avg),
      energy_prior_count: row.energy_prior_count,
      soreness_recent_avg: Number(row.soreness_recent_avg),
      soreness_prior_avg: Number(row.soreness_prior_avg),
    }).toEqual({
      energy_recent_avg: 2.5,
      energy_recent_count: 2,
      energy_prior_avg: 4.5,
      energy_prior_count: 2,
      soreness_recent_avg: 3.5,
      soreness_prior_avg: 1.5,
    });
  });

  test('a gym evening follows the gym day even though the UTC server is already on tomorrow', async () => {
    const { rows: [clock] } = await client.query<{ utc_date: string; gym_date: string }>(
      `select ($1::timestamptz)::date::text as utc_date,
              ($1::timestamptz at time zone 'America/New_York')::date::text as gym_date`,
      [GYM_EVENING.toISOString()],
    );
    expect(clock).toEqual({ utc_date: '2025-01-16', gym_date: '2025-01-15' });

    await addCheckIn({ date: gymDaysBefore(6), energy: 3, soreness: null }); // 6 gym days back: recent
    await addCheckIn({ date: gymDaysBefore(-1), energy: 1, soreness: null }); // tomorrow in the gym: left out

    const [row] = await getWellnessWindows(ORG_ID, [ATHLETE_ID], GYM_EVENING);
    expect(row.energy_recent_count).toBe(1);
    expect(Number(row.energy_recent_avg)).toBe(3);
    expect(row.energy_prior_count).toBe(0);
  });

  test('a skipped answer is left out of the average and the count, item by item', async () => {
    await addCheckIn({ date: gymDaysBefore(1), energy: 4, soreness: null });
    await addCheckIn({ date: gymDaysBefore(2), energy: null, soreness: 2 });
    await addCheckIn({ date: gymDaysBefore(3), energy: 2, soreness: null });

    const [row] = await getWellnessWindows(ORG_ID, [ATHLETE_ID], GYM_NOON);
    expect(row.energy_recent_count).toBe(2);
    expect(Number(row.energy_recent_avg)).toBe(3);
    expect(row.soreness_recent_count).toBe(1);
    expect(Number(row.soreness_recent_avg)).toBe(2);
  });

  test('scoped to the organization and to the athletes asked for', async () => {
    await addCheckIn({ date: gymDaysBefore(1), energy: 4, soreness: 2 });
    await addCheckIn({ date: gymDaysBefore(1), energy: 1, soreness: 5, orgId: OTHER_ORG_ID });
    await addCheckIn({ date: gymDaysBefore(1), energy: 1, soreness: 5, athleteId: OTHER_ATHLETE_ID });

    const rows = await getWellnessWindows(ORG_ID, [ATHLETE_ID], GYM_NOON);
    expect(rows.map((row) => [row.athlete_id, Number(row.energy_recent_avg)])).toEqual([[ATHLETE_ID, 4]]);
  });

  test('real rows through readWellnessDeclines: energy down a point and soreness up a point both read', async () => {
    for (const days of [10, 15, 20]) await addCheckIn({ date: gymDaysBefore(days), energy: 4, soreness: 2 });
    for (const days of [1, 3]) await addCheckIn({ date: gymDaysBefore(days), energy: 3, soreness: 3 });

    const rows = await getWellnessWindows(ORG_ID, [ATHLETE_ID], GYM_NOON);
    expect(readWellnessDeclines(rows).map((d) => [d.item, d.prior_avg, d.recent_avg, d.prior_count, d.recent_count]))
      .toEqual([
        ['energy', 4, 3, 3, 2],
        ['soreness', 2, 3, 3, 2],
      ]);
  });
});
