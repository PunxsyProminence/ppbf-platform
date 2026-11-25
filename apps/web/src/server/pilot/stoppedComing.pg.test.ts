// Real PostgreSQL-backed test for stoppedComing.ts (lane W4-6, SC-1; W4 item 6,
// OW27-30 to OW27-32; Overwatch's W4-6 answers Q2 A and Q3 A). './db' is
// mocked to route into the embedded server, so the module's real SQL runs
// against pilot.attendance_reconciled (the register, through
// getAttendanceLast28Days), pilot.session_run_athletes and
// pilot.session_script_runs built by the full schema.
//
// It NEVER connects to production or staging: an embedded server on a free
// local port, in a throwaway data directory.

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
import type { PilotRole } from './contracts';
import { startSessionScriptRun } from './sessionScriptRuns';
import { listStoppedComing } from './stoppedComing';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-stopped-coming-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const DATABASE_NAME = 'ppbf_test_stopped_coming';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const TODAY = '2026-11-25';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let gymCount = 0;

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

/** `days` before TODAY, as a gym-local ISO day. */
function daysAgo(days: number): string {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
}

function actor(organizationId: string, accountId: string, role: PilotRole): ActorIdentity {
  return { organizationId, accountId, role, athleteId: null };
}

interface Gym {
  organizationId: string;
  coach: ActorIdentity;
  coach2: ActorIdentity;
  admin: ActorIdentity;
  exCoach: ActorIdentity;
  athleteAccount: ActorIdentity;
}

/** A gym: two coaches and an organization admin with active memberships, a coach whose membership ended, and an athlete account. */
async function newGym(label: string): Promise<Gym> {
  gymCount += 1;
  const organizationId = `org-stopped-${label}-${gymCount}`;
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [organizationId],
  );
  const accounts: Array<[string, PilotRole, boolean]> = [
    [`coach@${organizationId}`, 'coach', true],
    [`coach2@${organizationId}`, 'coach', true],
    [`admin@${organizationId}`, 'organization_admin', true],
    [`excoach@${organizationId}`, 'coach', false],
  ];
  for (const [accountId, role, active] of accounts) {
    await client.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, $2, $3)`, [
      accountId, role, organizationId,
    ]);
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, $4)`,
      [accountId, organizationId, role, active],
    );
  }
  return {
    organizationId,
    coach: actor(organizationId, accounts[0][0], 'coach'),
    coach2: actor(organizationId, accounts[1][0], 'coach'),
    admin: actor(organizationId, accounts[2][0], 'organization_admin'),
    exCoach: actor(organizationId, accounts[3][0], 'coach'),
    athleteAccount: actor(organizationId, `athlete@${organizationId}`, 'athlete'),
  };
}

async function addAthlete(gym: Gym, athleteId: string, name: string, { active = true, deleted = false } = {}) {
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
        coach_id, created_at, updated_at, deleted_at)
     values ($1, $2, $3, '2012-01-01', '100', 'active', 'contact', $4, $5, now(), now(), $6)`,
    [gym.organizationId, athleteId, name, active, gym.coach.accountId, deleted ? new Date() : null],
  );
}

/** A day in the legacy register (rank 3 of the reconciled view). */
async function registerDay(gym: Gym, athleteId: string, day: string, status: 'present' | 'absent') {
  await client.query(
    `insert into pilot.attendance (organization_id, attendance_id, athlete_id, attendance_date, status)
     values ($1, gen_random_uuid(), $2, $3::date, $4)`,
    [gym.organizationId, athleteId, day, status],
  );
}

/** A class at 17:00 gym time, and a register mark on it (rank 2). */
async function classWithMark(gym: Gym, classId: string, day: string, athleteId: string, status: 'present' | 'absent') {
  await client.query(
    `insert into pilot.scheduler_classes
       (organization_id, class_id, title, start_at, end_at, location, capacity,
        scheduled_by_account_id, coach_account_id, status)
     values ($1, $2, $2,
             ($3 || ' 17:00')::timestamp at time zone 'America/New_York',
             ($3 || ' 18:00')::timestamp at time zone 'America/New_York',
             'Main floor', 20, $4, $4, 'open')`,
    [gym.organizationId, classId, day, gym.coach.accountId],
  );
  await client.query(
    `insert into pilot.scheduler_attendance
       (organization_id, attendance_id, class_id, athlete_id, status, method,
        checked_in_by_role, checked_in_by_account_id, checked_in_at)
     values ($1, $2, $3, $4, $5, 'coach_override', 'coach', $6, now())`,
    [gym.organizationId, `sa-${classId}-${athleteId}`, classId, athleteId, status, gym.coach.accountId],
  );
}

/** A "here" mark at 18:00 gym time on `day`; taken back if `removed`. */
async function hereMark(gym: Gym, runId: string, athleteId: string, day: string, { removed = false } = {}) {
  await client.query(
    `insert into pilot.session_run_athletes
       (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role, marked_at, removed_at, removed_by_account_id)
     values ($1, $2, $3, $4, 'coach', ($5 || ' 18:00')::timestamp at time zone 'America/New_York',
             case when $6 then now() end, case when $6 then $4 end)`,
    [gym.organizationId, runId, athleteId, gym.coach.accountId, day, removed],
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${DATABASE_NAME}`);
  await admin.query(`create database ${DATABASE_NAME}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
  await client.connect();
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (fullSchema.applyFullSchema as (c: Client, o: { infraDir: string }) => Promise<unknown>)(client, { infraDir: INFRA_DIR });
  activeClient = client;
});

afterAll(async () => {
  activeClient = null;
  await client?.end().catch(() => {});
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

describe('listStoppedComing on a real database', () => {
  test('who is listed, by the rulings: register and open-gym days, the boundary, tied runs, taken-back marks, left and deleted athletes, and the other gym', async () => {
    const gym = await newGym('who');
    const other = await newGym('other');

    await addAthlete(gym, 'ada', 'Ada Reyes'); // register present 20 days ago: listed, 20
    await registerDay(gym, 'ada', daysAgo(20), 'present');
    await registerDay(gym, 'ada', daysAgo(5), 'absent'); // an absent day is not coming

    await addAthlete(gym, 'ben', 'Ben Ortiz'); // register 20 days ago, open gym 3 days ago: not listed
    await registerDay(gym, 'ben', daysAgo(20), 'present');

    await addAthlete(gym, 'cy', 'Cy Marsh'); // never came: not listed

    await addAthlete(gym, 'dee', 'Dee Hart', { active: false }); // marked as left the gym: not listed
    await registerDay(gym, 'dee', daysAgo(30), 'present');

    await addAthlete(gym, 'eve', 'Eve Long', { deleted: true }); // deleted: not listed
    await registerDay(gym, 'eve', daysAgo(30), 'present');

    await addAthlete(gym, 'fay', 'Fay Cole'); // exactly 14 days: listed
    await registerDay(gym, 'fay', daysAgo(14), 'present');

    await addAthlete(gym, 'gus', 'Gus Pine'); // 13 days: not listed
    await registerDay(gym, 'gus', daysAgo(13), 'present');

    await addAthlete(gym, 'hal', 'Hal Moss'); // a tied run's mark 2 days ago, the register says absent: listed, 20
    await registerDay(gym, 'hal', daysAgo(20), 'present');
    await classWithMark(gym, 'class-hal', daysAgo(2), 'hal', 'absent');

    await addAthlete(gym, 'ivy', 'Ivy Rowe'); // an open-gym mark 4 days ago, taken back: listed, 30
    await registerDay(gym, 'ivy', daysAgo(30), 'present');

    await addAthlete(gym, 'jo', 'Jo Vance'); // open gym only, 16 days ago: came before, listed, 16
    await addAthlete(gym, 'kit', 'Kit Lane'); // the register only ever says absent: never came, not listed
    await registerDay(gym, 'kit', daysAgo(40), 'absent');

    const openGym = (await startSessionScriptRun(gym.organizationId, gym.coach.accountId, {})).run_id;
    await hereMark(gym, openGym, 'ben', daysAgo(3));
    await hereMark(gym, openGym, 'ivy', daysAgo(4), { removed: true });
    await hereMark(gym, openGym, 'jo', daysAgo(16));

    const tied = (await startSessionScriptRun(gym.organizationId, gym.coach2.accountId, {})).run_id;
    await client.query('update pilot.session_script_runs set class_id = $1 where organization_id = $2 and run_id = $3', [
      'class-hal', gym.organizationId, tied,
    ]);
    await hereMark(gym, tied, 'hal', daysAgo(2));

    // The other gym: the same athlete id came yesterday, by register and by open gym. Not ours.
    await addAthlete(other, 'ada', 'Ada Elsewhere');
    await registerDay(other, 'ada', daysAgo(1), 'present');
    const otherRun = (await startSessionScriptRun(other.organizationId, other.coach.accountId, {})).run_id;
    await hereMark(other, otherRun, 'ada', daysAgo(1));

    const expected = [
      { athlete_id: 'ivy', full_name: 'Ivy Rowe', last_came_day: daysAgo(30), days_since_came: 30 },
      { athlete_id: 'ada', full_name: 'Ada Reyes', last_came_day: daysAgo(20), days_since_came: 20 },
      { athlete_id: 'hal', full_name: 'Hal Moss', last_came_day: daysAgo(20), days_since_came: 20 },
      { athlete_id: 'jo', full_name: 'Jo Vance', last_came_day: daysAgo(16), days_since_came: 16 },
      { athlete_id: 'fay', full_name: 'Fay Cole', last_came_day: daysAgo(14), days_since_came: 14 },
    ];
    for (const reader of [gym.coach, gym.coach2, gym.admin]) {
      await expect(listStoppedComing(reader, TODAY)).resolves.toEqual({
        gap_days: 14, is_default: true, today: TODAY, athletes: expected,
      });
    }

    // The other gym sees only its own athlete, who came yesterday.
    await expect(listStoppedComing(other.coach, TODAY)).resolves.toMatchObject({ athletes: [] });
  });

  test('the gym\'s own number of days decides the list', async () => {
    const gym = await newGym('days');
    await addAthlete(gym, 'ada', 'Ada Reyes');
    await registerDay(gym, 'ada', daysAgo(20), 'present');
    await addAthlete(gym, 'ben', 'Ben Ortiz');
    await registerDay(gym, 'ben', daysAgo(30), 'present');

    await client.query(
      `insert into pilot.organization_stopped_coming_policy (organization_id, gap_days, set_by_account_id) values ($1, 28, $2)`,
      [gym.organizationId, gym.admin.accountId],
    );
    await expect(listStoppedComing(gym.coach, TODAY)).resolves.toEqual({
      gap_days: 28, is_default: false, today: TODAY,
      athletes: [{ athlete_id: 'ben', full_name: 'Ben Ortiz', last_came_day: daysAgo(30), days_since_came: 30 }],
    });
  });

  test('a coach whose membership ended, an athlete, and a staff member of another gym are refused (403), not given an empty list', async () => {
    const gym = await newGym('refused');
    const other = await newGym('refused-other');
    await addAthlete(gym, 'ada', 'Ada Reyes');
    await registerDay(gym, 'ada', daysAgo(20), 'present');

    await expect(listStoppedComing(gym.exCoach, TODAY)).rejects.toMatchObject({ status: 403 });
    await expect(listStoppedComing(gym.athleteAccount, TODAY)).rejects.toMatchObject({ status: 403 });
    // The other gym's coach, claiming this gym: no active membership here.
    await expect(listStoppedComing({ ...other.coach, organizationId: gym.organizationId }, TODAY)).rejects.toMatchObject({ status: 403 });
  });
});
