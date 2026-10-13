// Real PostgreSQL test for the attendance-by-athlete report's period (RP-01).
//
// The period is gym calendar days, inclusive, matched against the day each
// CLASS was on in the gym's time zone. Only a real database can say the
// boundary is right: a class at 11:30 pm Eastern on the last day is already
// the next day in UTC, and one at 11:30 pm the evening before the first day
// is already the first day in UTC. Both are seeded, with the arithmetic around
// them (present / absent / excused, a rate of null versus 0) and a second gym
// whose same-id athlete must not count.
//
// Spins up the same disposable, local-only embedded Postgres the other pg
// suites use. It NEVER connects to production or staging.

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
    return (await activeClient.query(text, params)).rows;
  }),
}));

import { getOrganizationAttendanceSummary } from './attendanceReporting';

jest.setTimeout(180_000);

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-attendance-report-period-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const ORG = 'org-report';
const OTHER_ORG = 'org-report-other';
const COACH = 'acct-report-coach';
const ATHLETE = 'ATH-REPORT-1';
const NEVER_MARKED = 'ATH-REPORT-2';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
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

/** A class at a gym wall-clock time, registered and marked for one athlete. */
async function markedClass(
  client: Client,
  org: string,
  classId: string,
  gymWallClock: string,
  status: 'present' | 'absent' | 'excused',
  athleteId = ATHLETE,
) {
  await client.query(
    `insert into pilot.scheduler_classes
       (organization_id, class_id, title, start_at, end_at, location, capacity, scheduled_by_account_id, coach_account_id, status)
     values ($1, $2, 'Fundamentals', ($3::timestamp at time zone 'America/New_York'),
             ($3::timestamp at time zone 'America/New_York') + interval '1 hour', 'Main Floor', 20, $4, $4, 'open')`,
    [org, classId, gymWallClock, COACH],
  );
  await client.query(
    `insert into pilot.scheduler_registrations
       (organization_id, registration_id, class_id, athlete_id, requested_by_role, requested_by_account_id, status)
     values ($1, $2, $3, $4, 'coach', $5, 'registered')`,
    [org, `reg-${classId}`, classId, athleteId, COACH],
  );
  await client.query(
    `insert into pilot.scheduler_attendance
       (organization_id, attendance_id, class_id, athlete_id, status, method, checked_in_by_role, checked_in_by_account_id, note, checked_in_at)
     values ($1, $2, $3, $4, $5, 'coach_override', 'coach', $6, 'a staff note', now())`,
    [org, `att-${classId}`, classId, athleteId, status, COACH],
  );
}

async function seededDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });

  for (const org of [ORG, OTHER_ORG]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
      [org],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`,
    [COACH, ORG],
  );
  for (const [org, athleteId, name] of [
    [ORG, ATHLETE, 'Ada Rivera'],
    [ORG, NEVER_MARKED, 'Bo Never'],
    [OTHER_ORG, ATHLETE, 'Other Gym Ada'],
  ] as const) {
    await client.query(
      `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
         emergency_contact, active_flag, coach_id, created_at, updated_at)
       values ($1, $2, $3, '2011-05-06', 'fly', 'active', 'contact', true, $4, now(), now())`,
      [org, athleteId, name, COACH],
    );
  }

  // Period under test: 2026-10-01 to 2026-10-13, inclusive, by gym day.
  await markedClass(client, ORG, 'c-eve-before', '2026-09-30 23:30', 'absent'); // 9-30 in the gym (10-01 in UTC): out
  await markedClass(client, ORG, 'c-first', '2026-10-01 18:00', 'present');
  await markedClass(client, ORG, 'c-mid', '2026-10-05 19:00', 'absent');
  await markedClass(client, ORG, 'c-excused', '2026-10-10 18:00', 'excused');
  await markedClass(client, ORG, 'c-last-night', '2026-10-13 23:30', 'present'); // 10-13 in the gym (10-14 in UTC): in
  await markedClass(client, ORG, 'c-after', '2026-10-14 18:00', 'present'); // out
  // The other gym's athlete with the same id, inside the period.
  await markedClass(client, OTHER_ORG, 'o-first', '2026-10-02 18:00', 'present');

  activeClient = client;
  return client;
}

beforeAll(async () => {
  PG_PORT = await findFreePort();
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });
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
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = fullSchema.applyFullSchema as typeof applyFullSchema;
});

afterEach(() => { activeClient = null; });

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

describe('the attendance report period (RP-01)', () => {
  test('counts by class day in gym time, edges included, with the arithmetic and no other gym', async () => {
    const client = await seededDatabase('arp_period');
    try {
      const rows = await getOrganizationAttendanceSummary(ORG, { fromDay: '2026-10-01', toDay: '2026-10-13' });

      const ada = rows.find((row) => row.athlete_id === ATHLETE);
      // c-first and c-last-night present; c-mid absent; c-excused excused.
      // The evening before the first day and the day after the last are out.
      expect(ada).toMatchObject({
        full_name: 'Ada Rivera',
        present_count: 2,
        absent_count: 1,
        excused_count: 1,
        total_marked: 4,
        attendance_rate: 0.667,
      });
      // Never marked: listed, with no rate rather than 0.
      expect(rows.find((row) => row.athlete_id === NEVER_MARKED)).toMatchObject({
        total_marked: 0,
        attendance_rate: null,
      });
      // The other gym's same-id athlete is not here, and its mark did not count.
      expect(rows.some((row) => row.full_name === 'Other Gym Ada')).toBe(false);
    } finally {
      await client.end();
    }
  });

  test('without a period, every mark counts, as the dashboard does today', async () => {
    const client = await seededDatabase('arp_all');
    try {
      const rows = await getOrganizationAttendanceSummary(ORG);
      expect(rows.find((row) => row.athlete_id === ATHLETE)).toMatchObject({ total_marked: 6, present_count: 3, absent_count: 2 });
    } finally {
      await client.end();
    }
  });

  test('a one-day period is that gym day only', async () => {
    const client = await seededDatabase('arp_one_day');
    try {
      const rows = await getOrganizationAttendanceSummary(ORG, { fromDay: '2026-10-13', toDay: '2026-10-13' });
      expect(rows.find((row) => row.athlete_id === ATHLETE)).toMatchObject({ total_marked: 1, present_count: 1, attendance_rate: 1 });
    } finally {
      await client.end();
    }
  });
});
