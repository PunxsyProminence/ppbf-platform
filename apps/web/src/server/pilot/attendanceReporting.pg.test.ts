// Real PostgreSQL-backed contract test for getWeeklyAttendanceTrend (#173).
//
// Round 9 adversarial review confirmed a real off-by-one: the query's window
// had no upper bound, so a still-in-progress current week with already-marked
// attendance rode along as an extra bucket -- a caller asking for "the last 8
// weeks" silently got 9. Every existing test for this function mocked
// query() and asserted only on the SQL string and bound parameters, which
// cannot exercise the actual date_trunc/interval arithmetic Postgres runs --
// exactly why the bug shipped green. This test lets Postgres itself evaluate
// the window against real class rows spread across real weeks.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration/contract suites use. It NEVER connects to production or staging.

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

import { getWeeklyAttendanceTrend } from './attendanceReporting';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-attendance-trend-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG_ID = 'org-attendance-trend';
const COACH_ID = 'acct-attendance-trend-coach';
const ATHLETE_ID = 'ATH-ATTENDANCE-TREND-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Trend Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  return client;
}

// startAtExpression is a fixed SQL literal this file controls (never
// user/param input), e.g. 'now()' or "now() - interval '1 week'" -- weeks
// are always exactly 7 days, so an N-week-earlier timestamp always lands in
// the week exactly N buckets before the current one regardless of what day
// "now" happens to be when the suite runs.
async function insertClass(client: Client, classId: string, startAtExpression: string): Promise<void> {
  await client.query(
    `insert into pilot.scheduler_classes (organization_id, class_id, title, start_at, end_at, location, capacity, scheduled_by_account_id, coach_account_id, status)
     values ($1, $2, 'Fundamentals', ${startAtExpression}, ${startAtExpression} + interval '1 hour', 'Main Floor', 20, $3, $3, 'open')`,
    [ORG_ID, classId, COACH_ID],
  );
}

async function insertRegistration(client: Client, registrationId: string, classId: string): Promise<void> {
  await client.query(
    `insert into pilot.scheduler_registrations (organization_id, registration_id, class_id, athlete_id, requested_by_role, requested_by_account_id, status)
     values ($1, $2, $3, $4, 'coach', $5, 'registered')`,
    [ORG_ID, registrationId, classId, ATHLETE_ID, COACH_ID],
  );
}

async function insertAttendance(client: Client, attendanceId: string, classId: string): Promise<void> {
  await client.query(
    `insert into pilot.scheduler_attendance (organization_id, attendance_id, class_id, athlete_id, status, method, checked_in_by_role, checked_in_by_account_id, note, checked_in_at)
     values ($1, $2, $3, $4, 'present', 'coach_override', 'coach', $5, '', now())`,
    [ORG_ID, attendanceId, classId, ATHLETE_ID, COACH_ID],
  );
}

/** A class registered and marked, in one call -- the shape every bucket in this suite needs. */
async function seedWeek(client: Client, label: string, startAtExpression: string): Promise<void> {
  await insertClass(client, `class-${label}`, startAtExpression);
  await insertRegistration(client, `reg-${label}`, `class-${label}`);
  await insertAttendance(client, `att-${label}`, `class-${label}`);
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
});

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

describe('getWeeklyAttendanceTrend against real Postgres', () => {
  afterEach(() => {
    activeClient = null;
  });

  test('a still-in-progress current week does not ride along as an extra bucket', async () => {
    const client = await freshDatabase('ppbf_test_attendance_trend_current_week');
    activeClient = client;
    try {
      // The bug: this class is in the CURRENT week and already has a mark,
      // which is exactly the condition that made the old query return
      // weeks + 1 buckets.
      await seedWeek(client, 'current', 'now()');
      await seedWeek(client, 'w1', "now() - interval '1 week'");
      await seedWeek(client, 'w2', "now() - interval '2 weeks'");
      await seedWeek(client, 'w3', "now() - interval '3 weeks'");

      const rows = await getWeeklyAttendanceTrend(ORG_ID, { weeks: 3 });

      expect(rows).toHaveLength(3);

      const { rows: [{ week_start: currentWeekStart }] } = await client.query<{ week_start: string }>(
        `select date_trunc('week', now())::date::text as week_start`,
      );
      expect(rows.map((row) => row.week_start)).not.toContain(currentWeekStart);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('weeks: 1 returns exactly the one most recent fully completed week', async () => {
    const client = await freshDatabase('ppbf_test_attendance_trend_weeks_one');
    activeClient = client;
    try {
      await seedWeek(client, 'current', 'now()');
      await seedWeek(client, 'w1', "now() - interval '1 week'");
      await seedWeek(client, 'w2', "now() - interval '2 weeks'");

      const rows = await getWeeklyAttendanceTrend(ORG_ID, { weeks: 1 });

      expect(rows).toHaveLength(1);
      expect(rows[0].present_count).toBe(1);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('returns every fully completed week inside the window, in order, with correct counts', async () => {
    const client = await freshDatabase('ppbf_test_attendance_trend_shape');
    activeClient = client;
    try {
      await seedWeek(client, 'w1', "now() - interval '1 week'");
      await seedWeek(client, 'w2a', "now() - interval '2 weeks'");
      // A second class the same week as w2a, marked absent -- proves the
      // group-by really buckets by week, not by class, and that a week's
      // rate reflects every mark in it.
      await insertClass(client, 'class-w2b', "now() - interval '2 weeks' + interval '1 day'");
      await insertRegistration(client, 'reg-w2b', 'class-w2b');
      await client.query(
        `insert into pilot.scheduler_attendance (organization_id, attendance_id, class_id, athlete_id, status, method, checked_in_by_role, checked_in_by_account_id, note, checked_in_at)
         values ($1, 'att-w2b', 'class-w2b', $2, 'absent', 'coach_override', 'coach', $3, '', now())`,
        [ORG_ID, ATHLETE_ID, COACH_ID],
      );

      const rows = await getWeeklyAttendanceTrend(ORG_ID, { weeks: 2 });

      expect(rows).toHaveLength(2);
      expect(rows[0].week_start < rows[1].week_start).toBe(true);

      const twoWeeksAgoBucket = rows[0];
      expect(twoWeeksAgoBucket.present_count).toBe(1);
      expect(twoWeeksAgoBucket.absent_count).toBe(1);
      expect(twoWeeksAgoBucket.total_marked).toBe(2);

      const oneWeekAgoBucket = rows[1];
      expect(oneWeekAgoBucket.present_count).toBe(1);
      expect(oneWeekAgoBucket.total_marked).toBe(1);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
