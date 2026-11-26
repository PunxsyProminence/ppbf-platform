// Real PostgreSQL-backed test for stoppedComing.ts (lane W4-6, SC-1; W4 item 6,
// OW27-30 to OW27-32; Overwatch's W4-6 answers Q2 A and Q3 A). './db' is
// mocked to route into the embedded server, so the module's real SQL runs
// against pilot.attendance_reconciled (the register, through
// getAttendanceLast28Days), pilot.session_run_athletes,
// pilot.session_script_runs and pilot.program_memberships (Overwatch on #2172)
// built by the full schema. And the reached-out mark end to end (SC-3a-2):
// setStoppedComingReachedOut through reachedOutMarks.ts into
// pilot.athlete_reached_out_marks, read back on the list.
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
import { listStoppedComing, setStoppedComingReachedOut } from './stoppedComing';

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

/**
 * A "here" mark at `time` gym time (18:00 unless given) on `day`; taken back if `removed`.
 * `wroteRegister` names the class whose register mark the tap created (the pointer
 * sessionRunClass.ts sets); left out, the tap wrote none (open gym, or a skipped write).
 */
async function hereMark(
  gym: Gym, runId: string, athleteId: string, day: string,
  { removed = false, time = '18:00', wroteRegister = null as string | null } = {},
) {
  await client.query(
    `insert into pilot.session_run_athletes
       (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role, marked_at, removed_at, removed_by_account_id,
        register_class_id, register_written_at)
     values ($1, $2, $3, $4, 'coach', ($5 || ' ' || $7)::timestamp at time zone 'America/New_York',
             case when $6 then now() end, case when $6 then $4 end,
             $8::text, case when $8::text is not null then now() end)`,
    [gym.organizationId, runId, athleteId, gym.coach.accountId, day, removed, time, wroteRegister],
  );
}

/** A program membership, as the admin's Program Memberships page records it; an ended one carries its end day. */
async function programMembership(gym: Gym, athleteId: string, program: string, status: 'active' | 'lapsed' | 'ended') {
  await client.query(
    `insert into pilot.program_memberships
       (organization_id, membership_id, athlete_id, program_name, status, started_on, ended_on, created_by_account_id)
     values ($1, gen_random_uuid()::text, $2, $3, $4, $5::date, case when $4 = 'ended' then $6::date end, $7)`,
    [gym.organizationId, athleteId, program, status, daysAgo(200), daysAgo(30), gym.admin.accountId],
  );
}

/** The display name the gym typed for a staff account (getStaffAuthorName reads it). */
async function displayName(actor: ActorIdentity, name: string) {
  await client.query(
    'insert into pilot.account_profiles (organization_id, account_id, staff_display_name) values ($1, $2, $3)',
    [actor.organizationId, actor.accountId, name],
  );
}

/**
 * The database stamps a reached-out mark with its own clock and the guard refuses to move it, so a
 * mark "made N days ago" is made now and moved back with this session's triggers off.
 */
async function backdateReachedOut(gym: Gym, athleteId: string, day: string) {
  await client.query('set session_replication_role = replica');
  try {
    await client.query(
      `update pilot.athlete_reached_out_marks set marked_at = ($3 || ' 12:00')::timestamp at time zone 'America/New_York'
        where organization_id = $1 and athlete_id = $2 and cleared_at is null`,
      [gym.organizationId, athleteId, day],
    );
  } finally {
    await client.query('set session_replication_role = origin');
  }
}

async function reachedOutRows(gym: Gym, athleteId: string) {
  const { rows } = await client.query(
    `select marked_by_account_id, cleared_by_account_id, cleared_kind
       from pilot.athlete_reached_out_marks where organization_id = $1 and athlete_id = $2 order by marked_at`,
    [gym.organizationId, athleteId],
  );
  return rows;
}

/** An account with an active membership in this gym, in `role`. */
async function member(gym: Gym, role: PilotRole): Promise<ActorIdentity> {
  const accountId = `${role}-member@${gym.organizationId}`;
  await client.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, $2, $3)`, [
    accountId, role, gym.organizationId,
  ]);
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, true)`,
    [accountId, gym.organizationId, role],
  );
  return actor(gym.organizationId, accountId, role);
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

    await addAthlete(gym, 'hal', 'Hal Moss'); // a tied tap 2 days ago wrote the register, later set to absent: listed, 20
    await registerDay(gym, 'hal', daysAgo(20), 'present');
    await classWithMark(gym, 'class-hal', daysAgo(2), 'hal', 'absent');

    await addAthlete(gym, 'ivy', 'Ivy Rowe'); // an open-gym mark 4 days ago, taken back: listed, 30
    await registerDay(gym, 'ivy', daysAgo(30), 'present');

    // Overwatch on #2172 (A): a tap the register does not hold counts as coming.
    await addAthlete(gym, 'ora', 'Ora Lund'); // tied tap 2 days ago wrote the register; the class was then cancelled: not listed
    await registerDay(gym, 'ora', daysAgo(20), 'present');
    await addAthlete(gym, 'pip', 'Pip Shaw'); // tied tap 2 days ago after the class was cancelled (write skipped): not listed
    await registerDay(gym, 'pip', daysAgo(20), 'present');
    await addAthlete(gym, 'quin', 'Quin Bell'); // tied tap 2 days ago, write skipped (cover moved): not listed
    await registerDay(gym, 'quin', daysAgo(20), 'present');
    await addAthlete(gym, 'jo', 'Jo Vance'); // open gym only, 16 days ago: came before, listed, 16
    await addAthlete(gym, 'max', 'Max Dunn'); // open gym at 23:30 gym time 14 days ago (04:30 UTC the next day): listed, 14
    await addAthlete(gym, 'nia', 'Nia Ford'); // register 20 days ago; a mark dated tomorrow does not count: listed, 20
    await registerDay(gym, 'nia', daysAgo(20), 'present');
    await addAthlete(gym, 'kit', 'Kit Lane'); // the register only ever says absent: never came, not listed
    await registerDay(gym, 'kit', daysAgo(40), 'absent');

    const openGym = (await startSessionScriptRun(gym.organizationId, gym.coach.accountId, {})).run_id;
    await hereMark(gym, openGym, 'ben', daysAgo(3));
    await hereMark(gym, openGym, 'ivy', daysAgo(4), { removed: true });
    await hereMark(gym, openGym, 'jo', daysAgo(16));
    await hereMark(gym, openGym, 'max', daysAgo(14), { time: '23:30' });
    await hereMark(gym, openGym, 'nia', daysAgo(-1));

    const tied = (await startSessionScriptRun(gym.organizationId, gym.coach2.accountId, {})).run_id;
    await client.query('update pilot.session_script_runs set class_id = $1 where organization_id = $2 and run_id = $3', [
      'class-hal', gym.organizationId, tied,
    ]);
    await hereMark(gym, tied, 'hal', daysAgo(2), { wroteRegister: 'class-hal' });
    await hereMark(gym, tied, 'quin', daysAgo(2));

    // A second tied session, on a class the office then cancels.
    await classWithMark(gym, 'class-cx', daysAgo(2), 'ora', 'present');
    const tied2 = (await startSessionScriptRun(gym.organizationId, gym.admin.accountId, {})).run_id;
    await client.query('update pilot.session_script_runs set class_id = $1 where organization_id = $2 and run_id = $3', [
      'class-cx', gym.organizationId, tied2,
    ]);
    await hereMark(gym, tied2, 'ora', daysAgo(2), { wroteRegister: 'class-cx' });
    await client.query(`update pilot.scheduler_classes set status = 'cancelled' where organization_id = $1 and class_id = 'class-cx'`, [
      gym.organizationId,
    ]);
    await hereMark(gym, tied2, 'pip', daysAgo(2));

    // The other gym: the same athlete id came yesterday, by register and by open gym. Not ours.
    await addAthlete(other, 'ada', 'Ada Elsewhere');
    await registerDay(other, 'ada', daysAgo(1), 'present');
    const otherRun = (await startSessionScriptRun(other.organizationId, other.coach.accountId, {})).run_id;
    await hereMark(other, otherRun, 'ada', daysAgo(1));

    const expected = [
      { athlete_id: 'ivy', full_name: 'Ivy Rowe', last_came_day: daysAgo(30), days_since_came: 30 },
      { athlete_id: 'ada', full_name: 'Ada Reyes', last_came_day: daysAgo(20), days_since_came: 20 },
      { athlete_id: 'hal', full_name: 'Hal Moss', last_came_day: daysAgo(20), days_since_came: 20 },
      { athlete_id: 'nia', full_name: 'Nia Ford', last_came_day: daysAgo(20), days_since_came: 20 },
      { athlete_id: 'jo', full_name: 'Jo Vance', last_came_day: daysAgo(16), days_since_came: 16 },
      { athlete_id: 'fay', full_name: 'Fay Cole', last_came_day: daysAgo(14), days_since_came: 14 },
      { athlete_id: 'max', full_name: 'Max Dunn', last_came_day: daysAgo(14), days_since_came: 14 },
    ].map((athlete) => ({ ...athlete, reached_out: null }));
    // A membership in the legacy 'admin' name reads it too.
    const legacyAdmin = await member(gym, 'admin');
    for (const reader of [gym.coach, gym.coach2, gym.admin, legacyAdmin]) {
      await expect(listStoppedComing(reader, TODAY)).resolves.toEqual({
        gap_days: 14, is_default: true, today: TODAY, athletes: expected,
      });
    }

    // The other gym sees only its own athlete, who came yesterday.
    await expect(listStoppedComing(other.coach, TODAY)).resolves.toMatchObject({ athletes: [] });
  });

  test('program memberships (Overwatch on #2172): active is listed; lapsed or ended only is not; none recorded is decided by active_flag alone; another gym\'s rows do not count', async () => {
    const gym = await newGym('members');
    const other = await newGym('members-other');
    // Each came 20 days ago, so each is listed unless the membership rule leaves them off.
    const cases: Array<[string, string, Array<['active' | 'lapsed' | 'ended', string]>, boolean]> = [
      ['mae', 'Mae Active', [['active', 'Youth Boxing']], true],
      ['lou', 'Lou Lapsed', [['lapsed', 'Youth Boxing']], false],
      ['ned', 'Ned Ended', [['ended', 'Youth Boxing']], false],
      ['ola', 'Ola None', [], true],
      ['pam', 'Pam Again', [['ended', 'Youth Boxing'], ['active', 'Youth Boxing']], true], // re-enrolled: a new active row
      ['raf', 'Raf Both', [['lapsed', 'Youth Boxing'], ['ended', 'Open Gym']], false],
      ['sid', 'Sid Mixed', [['lapsed', 'Youth Boxing'], ['active', 'Open Gym']], true],
    ];
    for (const [id, name, memberships] of cases) {
      await addAthlete(gym, id, name);
      await registerDay(gym, id, daysAgo(20), 'present');
      for (const [status, program] of memberships) await programMembership(gym, id, program, status);
    }
    // Marked as left, with an active membership: still not listed (active_flag is still required).
    await addAthlete(gym, 'tia', 'Tia Left', { active: false });
    await registerDay(gym, 'tia', daysAgo(20), 'present');
    await programMembership(gym, 'tia', 'Youth Boxing', 'active');
    // The other gym's rows for the same ids: an active one for lou does not list this gym's lou,
    // and a lapsed one for ola does not leave this gym's ola off.
    await addAthlete(other, 'lou', 'Lou Elsewhere');
    await programMembership(other, 'lou', 'Youth Boxing', 'active');
    await addAthlete(other, 'ola', 'Ola Elsewhere');
    await programMembership(other, 'ola', 'Youth Boxing', 'lapsed');

    const expected = cases
      .filter(([, , , listed]) => listed)
      .map(([id, name]) => ({ athlete_id: id, full_name: name, last_came_day: daysAgo(20), days_since_came: 20, reached_out: null }))
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
    expect(expected.map((a) => a.athlete_id)).toEqual(['mae', 'ola', 'pam', 'sid']);
    for (const reader of [gym.coach, gym.admin]) {
      await expect(listStoppedComing(reader, TODAY)).resolves.toEqual({
        gap_days: 14, is_default: true, today: TODAY, athletes: expected,
      });
    }

    // The office lapses Mae's only membership: she leaves the list; reactivated, she is back.
    await client.query(
      `update pilot.program_memberships set status = 'lapsed' where organization_id = $1 and athlete_id = 'mae'`,
      [gym.organizationId],
    );
    await expect(listStoppedComing(gym.coach, TODAY)).resolves.toMatchObject({
      athletes: expected.filter((a) => a.athlete_id !== 'mae'),
    });
    await client.query(
      `update pilot.program_memberships set status = 'active' where organization_id = $1 and athlete_id = 'mae'`,
      [gym.organizationId],
    );
    await expect(listStoppedComing(gym.coach, TODAY)).resolves.toMatchObject({ athletes: expected });
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
      athletes: [{ athlete_id: 'ben', full_name: 'Ben Ortiz', last_came_day: daysAgo(30), days_since_came: 30, reached_out: null }],
    });
  });

  test('a coach whose membership ended, an athlete, another gym\'s coach, and this gym\'s board, volunteer, staff and parent members are refused (403), not given an empty list', async () => {
    const gym = await newGym('refused');
    const other = await newGym('refused-other');
    await addAthlete(gym, 'ada', 'Ada Reyes');
    await registerDay(gym, 'ada', daysAgo(20), 'present');

    await expect(listStoppedComing(gym.exCoach, TODAY)).rejects.toMatchObject({ status: 403 });
    await expect(listStoppedComing(gym.athleteAccount, TODAY)).rejects.toMatchObject({ status: 403 });
    // The other gym's coach, claiming this gym: no active membership here.
    await expect(listStoppedComing({ ...other.coach, organizationId: gym.organizationId }, TODAY)).rejects.toMatchObject({ status: 403 });
    // Members of this gym in a role that is not staff here, each with an active membership.
    for (const role of ['board', 'volunteer', 'staff', 'parent'] as const) {
      await expect(listStoppedComing(await member(gym, role), TODAY)).rejects.toMatchObject({ status: 403 });
    }
  });

  test('the reached-out mark end to end (SC-3a-2): mark; came back by open gym or register; stopped again; re-mark replaces; shown only while newer; take back; refusals; no account id', async () => {
    const gym = await newGym('reached');
    const other = await newGym('reached-other');
    await displayName(gym.coach, 'Jordan');
    await displayName(gym.coach2, 'Sam');
    await displayName(gym.admin, 'Pat');
    // A new mark is stamped with the database's day, so this test's day is the database's.
    const today = (await client.query(`select (clock_timestamp() at time zone 'America/New_York')::date::text as day`)).rows[0].day as string;
    const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    const row = async (athleteId: string) => (await listStoppedComing(gym.coach, today)).athletes.find((a) => a.athlete_id === athleteId);

    await addAthlete(gym, 'ada', 'Ada Reyes');
    await registerDay(gym, 'ada', day(-40), 'present');
    await addAthlete(gym, 'ben', 'Ben Ortiz');
    await registerDay(gym, 'ben', day(-40), 'present');
    await addAthlete(gym, 'eve', 'Eve Long', { deleted: true });
    await registerDay(gym, 'eve', day(-40), 'present');
    await addAthlete(other, 'zed', 'Zed Elsewhere');
    await registerDay(other, 'zed', day(-40), 'present');

    // Mark: the list shows who and the day; a second coach's mark writes nothing.
    await expect(setStoppedComingReachedOut(gym.coach, 'ada', true, today)).resolves.toBe('marked');
    await expect(row('ada')).resolves.toEqual({
      athlete_id: 'ada', full_name: 'Ada Reyes', last_came_day: day(-40), days_since_came: 40,
      reached_out: { by_name: 'Jordan', on_day: today },
    });
    await expect(setStoppedComingReachedOut(gym.coach2, 'ada', true, today)).resolves.toBe('already_marked');

    // The mark was made 30 days ago; Ada came back to open gym 25 days ago and has stopped again.
    await backdateReachedOut(gym, 'ada', day(-30));
    await expect(row('ada')).resolves.toMatchObject({ reached_out: { by_name: 'Jordan', on_day: day(-30) } });
    const openGym = (await startSessionScriptRun(gym.organizationId, gym.coach.accountId, {})).run_id;
    await hereMark(gym, openGym, 'ada', day(-25));
    await expect(row('ada')).resolves.toMatchObject({ last_came_day: day(-25), days_since_came: 25, reached_out: null });
    // The stale mark is not taken back: there is nothing on the page to take back.
    await expect(setStoppedComingReachedOut(gym.admin, 'ada', false, today)).resolves.toBe('not_marked');
    // A new mark replaces it, in one transaction, the old row ended by the coach making the new one.
    await expect(setStoppedComingReachedOut(gym.coach2, 'ada', true, today)).resolves.toBe('marked');
    await expect(row('ada')).resolves.toMatchObject({ reached_out: { by_name: 'Sam', on_day: today } });
    expect(await reachedOutRows(gym, 'ada')).toEqual([
      { marked_by_account_id: gym.coach.accountId, cleared_by_account_id: gym.coach2.accountId, cleared_kind: 'replaced' },
      { marked_by_account_id: gym.coach2.accountId, cleared_by_account_id: null, cleared_kind: null },
    ]);

    // Ben's comeback is a register present day: the same.
    await setStoppedComingReachedOut(gym.coach, 'ben', true, today);
    await backdateReachedOut(gym, 'ben', day(-30));
    await registerDay(gym, 'ben', day(-20), 'present');
    await expect(row('ben')).resolves.toMatchObject({ last_came_day: day(-20), reached_out: null });
    await expect(setStoppedComingReachedOut(gym.admin, 'ben', true, today)).resolves.toBe('marked');
    await expect(row('ben')).resolves.toMatchObject({ reached_out: { by_name: 'Pat', on_day: today } });
    expect((await reachedOutRows(gym, 'ben')).map((r) => r.cleared_kind)).toEqual(['replaced', null]);

    // Take back: the row stays, ended; the list shows none; a second take-back has nothing to take.
    await expect(setStoppedComingReachedOut(gym.coach, 'ada', false, today)).resolves.toBe('taken_back');
    await expect(row('ada')).resolves.toMatchObject({ reached_out: null });
    await expect(setStoppedComingReachedOut(gym.coach, 'ada', false, today)).resolves.toBe('not_marked');
    expect((await reachedOutRows(gym, 'ada')).map((r) => r.cleared_kind)).toEqual(['replaced', 'taken_back']);

    // Refused, nothing written: another gym's athlete, a soft-deleted athlete, no such athlete (404);
    // a coach whose membership ended, an athlete, another gym's coach claiming this gym (403).
    for (const athleteId of ['zed', 'eve', 'nobody']) {
      await expect(setStoppedComingReachedOut(gym.coach, athleteId, true, today)).rejects.toMatchObject({ status: 404 });
    }
    await expect(setStoppedComingReachedOut(other.coach, 'ada', true, today)).rejects.toMatchObject({ status: 404 });
    for (const actor of [gym.exCoach, gym.athleteAccount, { ...other.coach, organizationId: gym.organizationId }]) {
      await expect(setStoppedComingReachedOut(actor, 'ben', false, today)).rejects.toMatchObject({ status: 403 });
    }
    const written = await client.query(
      `select organization_id, athlete_id from pilot.athlete_reached_out_marks where athlete_id in ('zed', 'eve', 'nobody')`,
    );
    expect(written.rows).toEqual([]);
    expect((await reachedOutRows(gym, 'ben')).map((r) => r.cleared_kind)).toEqual(['replaced', null]);

    // Every write audited, in order, with no note: who, what, and how a mark ended.
    const audits = await client.query(
      `select event_type, actor_role, details from pilot.audit_events
        where organization_id = $1 and entity_type = 'athlete_reached_out_mark' order by audit_id`,
      [gym.organizationId],
    );
    expect(audits.rows).toEqual([
      { event_type: 'create', actor_role: 'coach', details: { athlete_id: 'ada' } },
      { event_type: 'update', actor_role: 'coach', details: { athlete_id: 'ada', action: 'clear', cleared_kind: 'replaced' } },
      { event_type: 'create', actor_role: 'coach', details: { athlete_id: 'ada' } },
      { event_type: 'create', actor_role: 'coach', details: { athlete_id: 'ben' } },
      { event_type: 'update', actor_role: 'organization_admin', details: { athlete_id: 'ben', action: 'clear', cleared_kind: 'replaced' } },
      { event_type: 'create', actor_role: 'organization_admin', details: { athlete_id: 'ben' } },
      { event_type: 'update', actor_role: 'coach', details: { athlete_id: 'ada', action: 'clear', cleared_kind: 'taken_back' } },
    ]);

    // No account id anywhere in what the list returns, for any reader.
    for (const reader of [gym.coach, gym.admin]) {
      const text = JSON.stringify(await listStoppedComing(reader, today));
      for (const actor of [gym.coach, gym.coach2, gym.admin, gym.exCoach]) expect(text).not.toContain(actor.accountId);
      expect(text).not.toMatch(/mark_id|account/);
    }
  });

  // Reviewers J and K: a mark the page would never show is not written. The list's own rules decide.
  test('a mark is refused (409), with no row and no audit row, for an athlete not on the list now; a take-back needs no list check', async () => {
    const gym = await newGym('not-listed');
    const today = (await client.query(`select (clock_timestamp() at time zone 'America/New_York')::date::text as day`)).rows[0].day as string;
    const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    const refused = { status: 409, code: 'NOT_ON_STOPPED_COMING_LIST' };

    await addAthlete(gym, 'lia', 'Lia Left', { active: false }); // marked as left the gym
    await registerDay(gym, 'lia', day(-40), 'present');
    await addAthlete(gym, 'lou', 'Lou Lapsed'); // only a lapsed membership
    await registerDay(gym, 'lou', day(-40), 'present');
    await programMembership(gym, 'lou', 'Youth Boxing', 'lapsed');
    await addAthlete(gym, 'ned', 'Ned Ended'); // only ended memberships
    await registerDay(gym, 'ned', day(-40), 'present');
    await programMembership(gym, 'ned', 'Youth Boxing', 'ended');
    await programMembership(gym, 'ned', 'Open Gym', 'ended');
    await addAthlete(gym, 'cy', 'Cy Never'); // never came
    await addAthlete(gym, 'gus', 'Gus Recent'); // came 13 days ago: inside the gym's 14
    await registerDay(gym, 'gus', day(-13), 'present');
    await addAthlete(gym, 'tod', 'Tod Today'); // came today, by open gym
    await registerDay(gym, 'tod', day(-40), 'present');
    const run = (await startSessionScriptRun(gym.organizationId, gym.coach.accountId, {})).run_id;
    await hereMark(gym, run, 'tod', today, { time: '00:30' });
    await addAthlete(gym, 'jay', 'Jay Loop'); // came today, by the register
    await registerDay(gym, 'jay', today, 'present');
    await addAthlete(gym, 'fay', 'Fay Fourteen'); // exactly the gym's 14 days: on the list
    await registerDay(gym, 'fay', day(-14), 'present');
    await programMembership(gym, 'fay', 'Youth Boxing', 'active');

    for (const athleteId of ['lia', 'lou', 'ned', 'cy', 'gus', 'tod']) {
      await expect(setStoppedComingReachedOut(gym.coach, athleteId, true, today)).rejects.toMatchObject(refused);
    }
    // Reviewer J's loop on a day the athlete came: refused at the first mark, so nothing to take back or replace.
    await expect(setStoppedComingReachedOut(gym.coach, 'jay', true, today)).rejects.toMatchObject(refused);
    await expect(setStoppedComingReachedOut(gym.coach, 'jay', false, today)).resolves.toBe('not_marked');
    await expect(setStoppedComingReachedOut(gym.coach, 'jay', true, today)).rejects.toMatchObject(refused);
    await expect(setStoppedComingReachedOut(gym.coach2, 'jay', true, today)).rejects.toMatchObject(refused);

    const written = async () => ({
      marks: (await client.query('select athlete_id from pilot.athlete_reached_out_marks where organization_id = $1 order by athlete_id', [gym.organizationId])).rows,
      audits: (await client.query(
        `select details->>'athlete_id' as athlete_id, event_type from pilot.audit_events
          where organization_id = $1 and entity_type = 'athlete_reached_out_mark' order by audit_id`,
        [gym.organizationId],
      )).rows,
    });
    expect(await written()).toEqual({ marks: [], audits: [] });

    // On the list (the boundary day, an active membership): marks, and a repeat writes nothing.
    await expect(setStoppedComingReachedOut(gym.admin, 'fay', true, today)).resolves.toBe('marked');
    await expect(setStoppedComingReachedOut(gym.coach, 'fay', true, today)).resolves.toBe('already_marked');
    await expect(listStoppedComing(gym.coach, today)).resolves.toMatchObject({
      athletes: [{ athlete_id: 'fay', reached_out: { by_name: null, on_day: today } }],
    });

    // Fay is then marked as left: a new mark is refused, but her mark can still be taken back.
    await client.query(`update pilot.athletes set active_flag = false where organization_id = $1 and athlete_id = 'fay'`, [gym.organizationId]);
    await expect(setStoppedComingReachedOut(gym.coach, 'fay', true, today)).rejects.toMatchObject(refused);
    await expect(setStoppedComingReachedOut(gym.coach, 'fay', false, today)).resolves.toBe('taken_back');
    expect(await written()).toEqual({
      marks: [{ athlete_id: 'fay' }],
      audits: [{ athlete_id: 'fay', event_type: 'create' }, { athlete_id: 'fay', event_type: 'update' }],
    });
  });

  // Reviewer J, round 2: a "left" flag or a lapsed membership committed after the roster read and
  // BEGIN, before the list check, must refuse the mark. Deterministic: a second connection holds
  // the marker's membership row FOR UPDATE, so the PUT waits in lockStaffMembership, inside its
  // transaction; the change is committed while it waits, which releases it.
  test('a "left" flag or a lapsed membership committed while the mark waits inside its transaction refuses it (409), nothing written', async () => {
    const gym = await newGym('race-list');
    const today = (await client.query(`select (clock_timestamp() at time zone 'America/New_York')::date::text as day`)).rows[0].day as string;
    const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    for (const [id, name] of [['lia', 'Lia Leaving'], ['lou', 'Lou Lapsing'], ['ola', 'Ola Staying']]) {
      await addAthlete(gym, id, name);
      await registerDay(gym, id, day(-40), 'present');
      await programMembership(gym, id, 'Youth Boxing', 'active');
    }
    const markerPid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    const holder = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
    await holder.connect();

    /** The PUT for `athleteId`, with `change` committed on the holder while the PUT waits inside its transaction. */
    async function markWhileHeld(athleteId: string, change: string | null) {
      await holder.query('BEGIN');
      await holder.query(
        'select 1 from pilot.organization_memberships where account_id = $1 and organization_id = $2 for update',
        [gym.coach.accountId, gym.organizationId],
      );
      const marking = setStoppedComingReachedOut(gym.coach, athleteId, true, today).then(
        (outcome) => ({ outcome }),
        (error: { status?: number; code?: string }) => ({ status: error.status, code: error.code }),
      );
      for (let attempt = 0; ; attempt += 1) {
        // The holder polls from inside its own transaction, where activity is a snapshot: clear it each time.
        await holder.query('select pg_stat_clear_snapshot()');
        const { rows } = await holder.query(
          'select wait_event_type, query from pg_stat_activity where pid = $1',
          [markerPid],
        );
        if (rows[0]?.wait_event_type === 'Lock' && /organization_memberships/.test(rows[0].query)) break;
        if (attempt > 400) throw new Error('the mark never waited on the membership lock');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (change) await holder.query(change, [gym.organizationId, athleteId]);
      await holder.query('COMMIT');
      return marking;
    }

    try {
      await expect(markWhileHeld('lia', 'update pilot.athletes set active_flag = false where organization_id = $1 and athlete_id = $2'))
        .resolves.toEqual({ status: 409, code: 'NOT_ON_STOPPED_COMING_LIST' });
      await expect(markWhileHeld('lou', `update pilot.program_memberships set status = 'lapsed' where organization_id = $1 and athlete_id = $2`))
        .resolves.toEqual({ status: 409, code: 'NOT_ON_STOPPED_COMING_LIST' });
      // The control: the same hold with nothing committed during it marks.
      await expect(markWhileHeld('ola', null)).resolves.toEqual({ outcome: 'marked' });
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      await holder.end();
    }

    const marks = await client.query(
      'select athlete_id from pilot.athlete_reached_out_marks where organization_id = $1 order by athlete_id', [gym.organizationId],
    );
    expect(marks.rows).toEqual([{ athlete_id: 'ola' }]);
    const audits = await client.query(
      `select details->>'athlete_id' as athlete_id from pilot.audit_events
        where organization_id = $1 and entity_type = 'athlete_reached_out_mark'`,
      [gym.organizationId],
    );
    expect(audits.rows).toEqual([{ athlete_id: 'ola' }]);
  });

  // Codex on #2206 (P2): an admin lapsing the athlete's last active membership while the mark's
  // transaction runs must not leave a mark for an athlete no longer on the list. The mark holds the
  // membership rows FOR SHARE: a lapse not yet committed makes the mark wait, and once it commits the
  // mark reads it and is refused. Without the lock the mark reads the old row at once and is written.
  test('a membership lapse in flight while the mark runs is waited for and refuses the mark (409), nothing written', async () => {
    const gym = await newGym('race-membership');
    const today = (await client.query(`select (clock_timestamp() at time zone 'America/New_York')::date::text as day`)).rows[0].day as string;
    const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    await addAthlete(gym, 'liv', 'Liv Lapsing');
    await registerDay(gym, 'liv', day(-40), 'present');
    await programMembership(gym, 'liv', 'Youth Boxing', 'active');
    const markerPid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    const admin = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
    await admin.connect();
    try {
      await admin.query('BEGIN');
      await admin.query(
        `update pilot.program_memberships set status = 'lapsed' where organization_id = $1 and athlete_id = $2`,
        [gym.organizationId, 'liv'],
      );
      const marking = setStoppedComingReachedOut(gym.coach, 'liv', true, today).then(
        (outcome) => ({ outcome }),
        (error: { status?: number; code?: string }) => ({ status: error.status, code: error.code }),
      );
      for (let attempt = 0; ; attempt += 1) {
        await admin.query('select pg_stat_clear_snapshot()');
        const { rows } = await admin.query('select wait_event_type, query from pg_stat_activity where pid = $1', [markerPid]);
        if (rows[0]?.wait_event_type === 'Lock' && /program_memberships/.test(rows[0].query)) break;
        if (attempt > 400) throw new Error('the mark never waited on the membership rows');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await admin.query('COMMIT');
      await expect(marking).resolves.toEqual({ status: 409, code: 'NOT_ON_STOPPED_COMING_LIST' });
    } finally {
      await admin.query('ROLLBACK').catch(() => {});
      await admin.end();
    }
    const marks = await client.query('select count(*)::int as n from pilot.athlete_reached_out_marks where organization_id = $1', [gym.organizationId]);
    expect(marks.rows).toEqual([{ n: 0 }]);
  });
});

// Overwatch on #2206 (after Codex's P2): every fact a mark or a take-back rests on is read on the
// write's transaction with its rows locked, so a change on a second connection between the checks
// and the write is either waited for and read, or waits for the write. One test per fact.
describe('setStoppedComingReachedOut holds every fact it rests on until it commits', () => {
  type Answer = { outcome: string } | { status?: number; code?: string };

  /** The gym-local day now, by the database's clock: a here mark or register mark "today" is on it. */
  async function gymToday(): Promise<string> {
    return (await client.query(`select (clock_timestamp() at time zone 'America/New_York')::date::text as day`)).rows[0].day as string;
  }

  function dayFrom(today: string, offset: number): string {
    return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
  }

  /**
   * Runs `change` on a second connection and leaves it uncommitted, holding its rows; starts the PUT;
   * once the PUT waits on a lock in a statement naming `waitsOn`, commits the change, and answers
   * what the PUT answered. A PUT that finishes without waiting is answered as it is, with the change
   * then committed: that is the unlocked write these tests exist to catch.
   */
  async function putWithChangeInFlight(
    who: ActorIdentity, athleteId: string, reachedOut: boolean, today: string,
    change: ReadonlyArray<readonly [string, readonly unknown[]]>, waitsOn: RegExp,
  ): Promise<Answer & { waited: boolean }> {
    const markerPid = (await client.query('select pg_backend_pid() as pid')).rows[0].pid as number;
    const other = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
    await other.connect();
    try {
      await other.query('BEGIN');
      for (const [text, params] of change) await other.query(text, [...params]);
      let settled = false;
      const putting = setStoppedComingReachedOut(who, athleteId, reachedOut, today).then(
        (outcome): Answer => ({ outcome }),
        (error: { status?: number; code?: string }): Answer => ({ status: error.status, code: error.code }),
      ).finally(() => { settled = true; });
      let waited = false;
      for (let attempt = 0; !settled; attempt += 1) {
        await other.query('select pg_stat_clear_snapshot()');
        const { rows } = await other.query('select wait_event_type, query from pg_stat_activity where pid = $1', [markerPid]);
        if (rows[0]?.wait_event_type === 'Lock' && waitsOn.test(rows[0].query)) {
          waited = true;
          break;
        }
        if (attempt > 400) throw new Error(`the PUT neither finished nor waited on ${waitsOn}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      await other.query('COMMIT');
      return { ...(await putting), waited };
    } finally {
      await other.query('ROLLBACK').catch(() => {});
      await other.end();
    }
  }

  async function marksAndAudits(gym: Gym) {
    return {
      marks: (await client.query(
        'select athlete_id, cleared_kind from pilot.athlete_reached_out_marks where organization_id = $1 order by athlete_id, marked_at',
        [gym.organizationId],
      )).rows,
      audits: (await client.query(
        `select details->>'athlete_id' as athlete_id, event_type from pilot.audit_events
          where organization_id = $1 and entity_type = 'athlete_reached_out_mark' order by audit_id`,
        [gym.organizationId],
      )).rows,
    };
  }

  async function gone40Days(gym: Gym, athleteId: string, name: string, today: string) {
    await addAthlete(gym, athleteId, name);
    await registerDay(gym, athleteId, dayFrom(today, -40), 'present');
  }

  test('the staff member: a membership ended or an account turned off in flight is waited for and refuses the write (403)', async () => {
    const gym = await newGym('held-staff');
    const today = await gymToday();
    await gone40Days(gym, 'abe', 'Abe Athlete', today);
    const membershipOff = [[
      'update pilot.organization_memberships set active_flag = false where account_id = $1 and organization_id = $2',
      [gym.coach.accountId, gym.organizationId],
    ]] as const;
    const accountOff = [['update pilot.accounts set active_flag = false where account_id = $1', [gym.coach2.accountId]]] as const;
    const noChange = [[
      'update pilot.organization_memberships set active_flag = true where account_id = $1 and organization_id = $2',
      [gym.admin.accountId, gym.organizationId],
    ]] as const;

    await expect(putWithChangeInFlight(gym.coach, 'abe', true, today, membershipOff, /organization_memberships/))
      .resolves.toEqual({ status: 403, code: undefined, waited: true });
    await expect(putWithChangeInFlight(gym.coach2, 'abe', true, today, accountOff, /organization_memberships/))
      .resolves.toEqual({ status: 403, code: undefined, waited: true });
    expect(await marksAndAudits(gym)).toEqual({ marks: [], audits: [] });
    // The control: the same wait, with a change that leaves the admin staff, marks.
    await expect(putWithChangeInFlight(gym.admin, 'abe', true, today, noChange, /organization_memberships/))
      .resolves.toEqual({ outcome: 'marked', waited: true });
  });

  test('the athlete row: a soft delete or a "left" flag in flight is waited for and refuses the write (404, 409), nothing written', async () => {
    const gym = await newGym('held-athlete');
    const today = await gymToday();
    await gone40Days(gym, 'dee', 'Dee Deleted', today);
    await gone40Days(gym, 'lea', 'Lea Leaving', today);
    const set = (column: string, value: string, athleteId: string) => [[
      `update pilot.athletes set ${column} = ${value} where organization_id = $1 and athlete_id = $2`,
      [gym.organizationId, athleteId],
    ]] as const;

    await expect(putWithChangeInFlight(gym.coach, 'dee', true, today, set('deleted_at', 'now()', 'dee'), /pilot\.athletes/))
      .resolves.toEqual({ status: 404, code: undefined, waited: true });
    await expect(putWithChangeInFlight(gym.coach, 'lea', true, today, set('active_flag', 'false', 'lea'), /pilot\.athletes/))
      .resolves.toEqual({ status: 409, code: 'NOT_ON_STOPPED_COMING_LIST', waited: true });
    expect(await marksAndAudits(gym)).toEqual({ marks: [], audits: [] });
  });

  test('program memberships: a first membership recorded lapsed in flight is waited for and refuses the mark (409), nothing written', async () => {
    // Codex's P2 is the lapse of an existing membership (the test above this describe). An athlete
    // with no membership has no row to hold: the new row's foreign key check waits on the athlete row.
    const gym = await newGym('held-first-membership');
    const today = await gymToday();
    await gone40Days(gym, 'fin', 'Fin First', today);
    const firstLapsed = [[
      `insert into pilot.program_memberships
         (organization_id, membership_id, athlete_id, program_name, status, started_on, created_by_account_id)
       values ($1, gen_random_uuid()::text, $2, 'Youth Boxing', 'lapsed', $3::date, $4)`,
      [gym.organizationId, 'fin', dayFrom(today, -100), gym.admin.accountId],
    ]] as const;

    await expect(putWithChangeInFlight(gym.coach, 'fin', true, today, firstLapsed, /pilot\.athletes/))
      .resolves.toEqual({ status: 409, code: 'NOT_ON_STOPPED_COMING_LIST', waited: true });
    expect(await marksAndAudits(gym)).toEqual({ marks: [], audits: [] });
  });

  test("the gym's number of days: a change in flight is waited for and read (409 at 56 days; marks when put back to the default)", async () => {
    const gym = await newGym('held-days');
    const today = await gymToday();
    await addAthlete(gym, 'gia', 'Gia Gone');
    await registerDay(gym, 'gia', dayFrom(today, -20), 'present');
    // As setStoppedComingPolicy saves: the gym row FOR NO KEY UPDATE first, then the setting.
    const save = (sql: string, params: readonly unknown[]) => [
      ['select 1 from pilot.organizations where organization_id = $1 for no key update', [gym.organizationId]],
      [sql, params],
    ] as const;
    const to56 = save(
      `insert into pilot.organization_stopped_coming_policy (organization_id, gap_days, set_by_account_id, set_at)
       values ($1, 56, $2, clock_timestamp())`,
      [gym.organizationId, gym.admin.accountId],
    );
    const backToDefault = save('delete from pilot.organization_stopped_coming_policy where organization_id = $1', [gym.organizationId]);

    // Gone 20 days: listed at the default 14, not at 56.
    await expect(putWithChangeInFlight(gym.coach, 'gia', true, today, to56, /pilot\.organizations/))
      .resolves.toEqual({ status: 409, code: 'NOT_ON_STOPPED_COMING_LIST', waited: true });
    expect(await marksAndAudits(gym)).toEqual({ marks: [], audits: [] });
    await expect(putWithChangeInFlight(gym.coach, 'gia', true, today, backToDefault, /pilot\.organizations/))
      .resolves.toEqual({ outcome: 'marked', waited: true });
  });

  test('the last day they came: a register mark or a here mark made in flight is waited for and read (mark 409; take-back not_marked)', async () => {
    const gym = await newGym('held-came');
    const today = await gymToday();
    for (const [id, name] of [['rex', 'Rex Register'], ['hal', 'Hal Here'], ['tia', 'Tia Taken']]) {
      await gone40Days(gym, id, name, today);
    }
    // A class today, committed, for the register mark; a run, committed, for the here marks.
    await classWithMark(gym, 'class-today', today, 'tia', 'absent');
    const run = (await startSessionScriptRun(gym.organizationId, gym.coach.accountId, {})).run_id;
    const registerPresent = [[
      `insert into pilot.scheduler_attendance
         (organization_id, attendance_id, class_id, athlete_id, status, method,
          checked_in_by_role, checked_in_by_account_id, checked_in_at)
       values ($1, 'sa-today-rex', 'class-today', 'rex', 'present', 'coach_override', 'coach', $2, now())`,
      [gym.organizationId, gym.coach.accountId],
    ]] as const;
    const here = (athleteId: string) => [[
      `insert into pilot.session_run_athletes (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role)
       values ($1, $2, $3, $4, 'coach')`,
      [gym.organizationId, run, athleteId, gym.coach.accountId],
    ]] as const;

    await expect(putWithChangeInFlight(gym.coach, 'rex', true, today, registerPresent, /pilot\.athletes/))
      .resolves.toEqual({ status: 409, code: 'NOT_ON_STOPPED_COMING_LIST', waited: true });
    await expect(putWithChangeInFlight(gym.coach, 'hal', true, today, here('hal'), /pilot\.athletes/))
      .resolves.toEqual({ status: 409, code: 'NOT_ON_STOPPED_COMING_LIST', waited: true });
    // Tia is marked today; she then comes today, in flight while the mark is taken back. Once she
    // has come, today's mark is not newer than her last day, so there is no mark to take back.
    await expect(setStoppedComingReachedOut(gym.coach, 'tia', true, today)).resolves.toBe('marked');
    await expect(putWithChangeInFlight(gym.coach2, 'tia', false, today, here('tia'), /pilot\.athletes/))
      .resolves.toEqual({ outcome: 'not_marked', waited: true });
    expect(await marksAndAudits(gym)).toEqual({
      marks: [{ athlete_id: 'tia', cleared_kind: null }],
      audits: [{ athlete_id: 'tia', event_type: 'create' }],
    });
  });
});
