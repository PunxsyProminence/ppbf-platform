// Real PostgreSQL-backed test for onTheFloor.ts (lane W4-3, FN-1; W4 item 3; Jason Q3.1 C and
// Q3.3 A, FN0-Q2 A and FN0-Q6 A; App Overwatch's FN0-Q1 A; GO on #2192). './db' is mocked to
// route into the embedded server, so the module's real SQL runs against pilot.session_run_athletes,
// pilot.session_script_runs, pilot.scheduler_attendance and pilot.scheduler_classes built by the
// full schema, and the real idle close (closeIdleSessionRuns) settles runs in it.
//
// The mock can also fail one statement or the idle close's transaction on purpose, so the suite
// shows that a failure anywhere fails the whole read (FN-0 F15; the GO's test condition).
//
// It NEVER connects to production or staging: an embedded server on a free local port, in a
// throwaway data directory.

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
/** When set, a query whose SQL matches is failed instead of run (a database failure, by SQLSTATE). */
let mockFailQuery: RegExp | null = null;
/** When set, every transaction fails before its first statement (the idle close's path). */
let mockFailTransactions = false;

function mockInjectedFailure(): Error {
  return Object.assign(new Error('injected failure for the test'), { code: 'XX000' });
}

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    if (mockFailQuery?.test(text)) throw mockInjectedFailure();
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    if (mockFailQuery?.test(text)) throw mockInjectedFailure();
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    if (mockFailTransactions) throw mockInjectedFailure();
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
import { ForbiddenError } from './errors';
import { listOnTheFloorForStaff } from './onTheFloor';
import { startSessionScriptRun } from './sessionScriptRuns';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-on-the-floor-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const DATABASE_NAME = 'ppbf_test_on_the_floor';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const NOW = new Date('2026-11-25T20:00:00Z'); // 15:00 at the gym (America/New_York, UTC-5 in November)
const TODAY = '2026-11-25';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let gymCount = 0;
let coachCount = 0;

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

/** NOW plus `minutes` (negative for earlier), as an ISO timestamp. */
function at(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

function actor(organizationId: string, accountId: string, role: PilotRole): ActorIdentity {
  return { organizationId, accountId, role, athleteId: null };
}

interface Gym {
  organizationId: string;
  coach: ActorIdentity;
  admin: ActorIdentity;
  exCoach: ActorIdentity;
}

/** A gym: a coach and an organization admin with active memberships, and a coach whose membership ended. */
async function newGym(label: string): Promise<Gym> {
  gymCount += 1;
  const organizationId = `org-floor-${label}-${gymCount}`;
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [organizationId],
  );
  const accounts: Array<[string, PilotRole, boolean]> = [
    [`coach@${organizationId}`, 'coach', true],
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
    admin: actor(organizationId, accounts[1][0], 'organization_admin'),
    exCoach: actor(organizationId, accounts[2][0], 'coach'),
  };
}

/** An account with an active membership in this gym, in `role`. */
async function member(gym: Gym, role: PilotRole): Promise<ActorIdentity> {
  coachCount += 1;
  const accountId = `${role}-${coachCount}@${gym.organizationId}`;
  await client.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, $2, $3)`, [
    accountId, role, gym.organizationId,
  ]);
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, $3, true)`,
    [accountId, gym.organizationId, role],
  );
  return actor(gym.organizationId, accountId, role);
}

async function addAthlete(gym: Gym, athleteId: string, name: string, { deleted = false } = {}) {
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
        coach_id, created_at, updated_at, deleted_at)
     values ($1, $2, $3, '2012-01-01', '100', 'active', 'contact', true, $4, now(), now(), $5)`,
    [gym.organizationId, athleteId, name, gym.coach.accountId, deleted ? new Date() : null],
  );
}

/** A class at `startLocal` gym time on `day` (one hour long). */
async function addClass(gym: Gym, classId: string, day: string, startLocal: string, { cancelled = false } = {}) {
  await client.query(
    `insert into pilot.scheduler_classes
       (organization_id, class_id, title, start_at, end_at, location, capacity,
        scheduled_by_account_id, coach_account_id, status)
     values ($1, $2, $2,
             ($3 || ' ' || $4)::timestamp at time zone 'America/New_York',
             ($3 || ' ' || $4)::timestamp at time zone 'America/New_York' + interval '1 hour',
             'Main floor', 20, $5, $5, $6)`,
    [gym.organizationId, classId, day, startLocal, gym.coach.accountId, cancelled ? 'cancelled' : 'open'],
  );
}

type MarkBy = 'coach' | 'walk_in' | 'self' | 'parent' | 'old_parent';

/** A register mark, written at `writtenAt`, by `by` (the method and role the scheduler records for it). */
async function registerMark(
  gym: Gym, classId: string, athleteId: string, status: 'present' | 'absent' | 'excused', writtenAt: string, by: MarkBy = 'coach',
) {
  const [method, role] = {
    coach: ['coach_override', 'coach'],
    walk_in: ['walk_in', 'coach'],
    self: ['self', 'athlete'],
    parent: ['parent', 'parent'],
    // A parent's mark from before the parent-method migration (schedulerDb.ts FAMILY_ATTENDANCE_UPSERT_SQL).
    old_parent: ['coach_override', 'parent'],
  }[by];
  await client.query(
    `insert into pilot.scheduler_attendance
       (organization_id, attendance_id, class_id, athlete_id, status, method,
        checked_in_by_role, checked_in_by_account_id, checked_in_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $9::timestamptz)`,
    [gym.organizationId, `sa-${classId}-${athleteId}`, classId, athleteId, status, method, role, gym.coach.accountId, writtenAt],
  );
}

/** A plain run started by `by` (a staff actor of this gym), its clock set to start at `startedAt`. */
async function liveRun(gym: Gym, by: ActorIdentity): Promise<string> {
  return (await startSessionScriptRun(gym.organizationId, by.accountId, {})).run_id;
}

async function setRunStart(gym: Gym, runId: string, startedAt: string) {
  await client.query(
    'update pilot.session_script_runs set started_at = $3::timestamptz where organization_id = $1 and run_id = $2',
    [gym.organizationId, runId, startedAt],
  );
}

async function tieRun(gym: Gym, runId: string, classId: string) {
  await client.query('update pilot.session_script_runs set class_id = $3 where organization_id = $1 and run_id = $2', [
    gym.organizationId, runId, classId,
  ]);
}

/** A "here" mark at `markedAt`; taken back if `removed`. */
async function hereMark(gym: Gym, runId: string, athleteId: string, markedAt: string, { removed = false } = {}) {
  await client.query(
    `insert into pilot.session_run_athletes
       (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role, marked_at, removed_at, removed_by_account_id)
     values ($1, $2, $3, $4, 'coach', $5::timestamptz,
             case when $6 then $5::timestamptz + interval '1 minute' end, case when $6 then $4 end)`,
    [gym.organizationId, runId, athleteId, gym.coach.accountId, markedAt, removed],
  );
}

async function runState(gym: Gym, runId: string): Promise<string> {
  const { rows } = await client.query<{ run_state: string }>(
    'select run_state from pilot.session_script_runs where organization_id = $1 and run_id = $2',
    [gym.organizationId, runId],
  );
  return rows[0].run_state;
}

function names(line: { athletes: readonly { full_name: string }[] }): string[] {
  return line.athletes.map((athlete) => athlete.full_name);
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

afterEach(() => {
  mockFailQuery = null;
  mockFailTransactions = false;
});

describe('listOnTheFloorForStaff on a real database', () => {
  test('who counts, by the rulings: live-run marks and today\'s register, for a coach and the gym admin alike', async () => {
    const gym = await newGym('who');
    const other = await newGym('other');
    const [coachB, coachC, coachD, coachE] = [
      await member(gym, 'coach'), await member(gym, 'coach'), await member(gym, 'coach'), await member(gym, 'coach'),
    ];
    for (const [id, name] of [
      ['ada', 'Ada'], ['ben', 'Ben'], ['cal', 'Cal'], ['dot', 'Dot'], ['eli', 'Eli'], ['fay', 'Fay'], ['gus', 'Gus'],
      ['hal', 'Hal'], ['jon', 'Jon'], ['kim', 'Kim'], ['lou', 'Lou'], ['max', 'Max'], ['ned', 'Ned'], ['oda', 'Oda'],
      ['pam', 'Pam'], ['quo', 'Quo'], ['rex', 'Rex'], ['sal', 'Sal'], ['tia', 'Tia'], ['uma', 'Uma'], ['vic', 'Vic'],
      ['wes', 'Wes'], ['xia', 'Xia'], ['yan', 'Yan'], ['zed', 'Zed'],
    ]) {
      await addAthlete(gym, id, name);
    }
    await addAthlete(gym, 'ivy', 'Ivy', { deleted: true });
    await addAthlete(other, 'jon', 'Jon Elsewhere');

    // Every run is started before any clock is set: a start sweeps idle runs on the real clock.
    const open = await liveRun(gym, gym.coach); // open gym (untied)
    const sentHome = await liveRun(gym, coachB); // tied to a class whose register later says Excused
    const cancelledTie = await liveRun(gym, coachC); // tied to a class the office cancelled
    const settled = await liveRun(gym, coachD); // finished
    const forgotten = await liveRun(gym, coachE); // idle past 3 hours, never closed by anyone
    const otherRun = await liveRun(other, other.coach);

    await addClass(gym, 'k-sent-home', TODAY, '14:30');
    await addClass(gym, 'k-cancelled', TODAY, '13:00', { cancelled: true });
    await addClass(gym, 'k-early', TODAY, '14:00'); // started an hour ago
    await addClass(gym, 'k-evening', TODAY, '18:00'); // starts in three hours
    await addClass(gym, 'k-yesterday', '2026-11-24', '17:00');
    await addClass(gym, 'k-tomorrow', '2026-11-26', '17:00');
    await addClass(gym, 'k-cancel-reg', TODAY, '12:00', { cancelled: true });
    await addClass(gym, 'k-late-yesterday', '2026-11-24', '23:30'); // 04:30 UTC on the 25th: the gym's 24th
    await addClass(gym, 'k-after-midnight', TODAY, '00:30');
    await addClass(other, 'k-other', TODAY, '14:00');

    for (const runId of [open, sentHome, cancelledTie, settled]) await setRunStart(gym, runId, at(-30));
    await client.query('update pilot.session_script_runs set started_at = $2::timestamptz where organization_id = $1 and run_id = $3', [
      other.organizationId, at(-30), otherRun,
    ]);
    await setRunStart(gym, forgotten, at(-300));
    await tieRun(gym, sentHome, 'k-sent-home');
    await tieRun(gym, cancelledTie, 'k-cancelled');

    // The run half.
    await hereMark(gym, open, 'ada', at(-20)); // standing: counted
    await hereMark(gym, open, 'ben', at(-20), { removed: true }); // taken back: not
    await hereMark(gym, open, 'ivy', at(-20)); // deleted athlete: not
    await hereMark(gym, sentHome, 'cal', at(-20)); // later Excused on the tied class: not (FN0-Q6 A)
    await registerMark(gym, 'k-sent-home', 'cal', 'excused', at(-10));
    await hereMark(gym, sentHome, 'dot', at(-20)); // an Absent written BEFORE the mark does not take her off
    await registerMark(gym, 'k-sent-home', 'dot', 'absent', at(-40));
    await hereMark(gym, sentHome, 'eli', at(-20)); // both records: counted once
    await registerMark(gym, 'k-sent-home', 'eli', 'present', at(-19));
    await hereMark(gym, cancelledTie, 'fay', at(-20)); // a run tied to a cancelled class stays on the staff line (FN0-Q1 A)
    await hereMark(gym, settled, 'gus', at(-20)); // its run is then finished: not
    await client.query(
      `update pilot.session_script_runs set run_state = 'completed', ended_at = $3::timestamptz where organization_id = $1 and run_id = $2`,
      [gym.organizationId, settled, at(-5)],
    );
    await hereMark(gym, forgotten, 'hal', at(-240)); // last activity four hours ago: closed by the read, not shown
    await hereMark(other, otherRun, 'jon', at(-20)); // the other gym's athlete of the same id: not ours

    // The register half.
    await registerMark(gym, 'k-early', 'kim', 'present', at(-360), 'self'); // the family's own mark, class started: counted
    await registerMark(gym, 'k-early', 'lou', 'present', at(-120)); // staff mark: counted
    await registerMark(gym, 'k-evening', 'max', 'present', at(-360), 'self'); // family's own, class not started: not (FN0-Q2 A)
    await registerMark(gym, 'k-evening', 'ned', 'present', at(-60), 'parent'); // a parent's: not yet
    await registerMark(gym, 'k-evening', 'oda', 'present', at(-60), 'old_parent'); // an older parent mark: not yet
    await registerMark(gym, 'k-evening', 'pam', 'present', at(-180)); // staff mark before the class: counted from when written
    await registerMark(gym, 'k-evening', 'quo', 'present', at(-60), 'walk_in'); // a walk-in is a staff mark: counted
    await registerMark(gym, 'k-yesterday', 'rex', 'present', at(-60)); // another day's class: not
    await registerMark(gym, 'k-tomorrow', 'sal', 'present', at(-60)); // another day's class: not
    await registerMark(gym, 'k-cancel-reg', 'tia', 'present', at(-200)); // a cancelled class stays on the staff line (FN0-Q1 A)
    await registerMark(gym, 'k-early', 'uma', 'absent', at(-60)); // absent: not
    await registerMark(gym, 'k-early', 'vic', 'excused', at(-60)); // excused: not
    await registerMark(gym, 'k-early', 'wes', 'present', at(30)); // written after now: not yet
    await registerMark(gym, 'k-late-yesterday', 'xia', 'present', at(-600)); // the gym's yesterday: not
    await registerMark(gym, 'k-after-midnight', 'yan', 'present', at(-600)); // the gym's today: counted
    await registerMark(gym, 'k-early', 'ivy', 'present', at(-60)); // deleted athlete: not
    await registerMark(other, 'k-other', 'jon', 'present', at(-60)); // the other gym's register: not ours
    await client.query( // the legacy table alone puts nobody on the line (FN-0 F9)
      `insert into pilot.attendance (organization_id, attendance_id, athlete_id, attendance_date, status)
       values ($1, gen_random_uuid(), 'zed', $2::date, 'present')`,
      [gym.organizationId, TODAY],
    );

    expect(await runState(gym, forgotten)).toBe('in_progress');
    const line = await listOnTheFloorForStaff(gym.coach, NOW);
    expect(line.day).toBe(TODAY);
    expect(names(line)).toEqual(['Ada', 'Dot', 'Eli', 'Fay', 'Kim', 'Lou', 'Pam', 'Quo', 'Tia', 'Yan']);
    // Nothing but the day and each athlete's id and name leaves the read.
    expect(Object.keys(line).sort()).toEqual(['athletes', 'day']);
    for (const athlete of line.athletes) expect(Object.keys(athlete).sort()).toEqual(['athlete_id', 'full_name']);
    expect(line.athletes.find((athlete) => athlete.full_name === 'Ada')?.athlete_id).toBe('ada');

    // The read settled the forgotten run first, as abandoned; the finished one is left as it was.
    expect(await runState(gym, forgotten)).toBe('abandoned');
    expect(await runState(gym, settled)).toBe('completed');
    expect(await runState(gym, open)).toBe('in_progress');

    // A coach's reach is the whole gym: the gym admin reads the same line.
    expect(names(await listOnTheFloorForStaff(gym.admin, NOW))).toEqual(names(line));
    // And the other gym reads only its own.
    expect(names(await listOnTheFloorForStaff(other.coach, NOW))).toEqual(['Jon Elsewhere']);
  });

  test('a family mark counts from its class\'s start, to the end of that gym day', async () => {
    const gym = await newGym('start');
    await addAthlete(gym, 'amy', 'Amy');
    await addClass(gym, 'k-five', TODAY, '17:00');
    await registerMark(gym, 'k-five', 'amy', 'present', at(-360), 'self');
    expect(names(await listOnTheFloorForStaff(gym.coach, NOW))).toEqual([]); // 15:00: before the class
    expect(names(await listOnTheFloorForStaff(gym.coach, new Date(Date.parse('2026-11-25T22:00:00Z'))))).toEqual(['Amy']); // 17:00
    expect(names(await listOnTheFloorForStaff(gym.coach, new Date(Date.parse('2026-11-26T04:59:00Z'))))).toEqual(['Amy']); // 23:59
    expect(names(await listOnTheFloorForStaff(gym.coach, new Date(Date.parse('2026-11-26T05:00:00Z'))))).toEqual([]); // the next gym day
  });

  test('a caller with no active staff membership here is refused (403) before anything is read or closed', async () => {
    const gym = await newGym('refused');
    const other = await newGym('refused-other');
    await addAthlete(gym, 'amy', 'Amy');
    const forgotten = await liveRun(gym, gym.coach);
    await setRunStart(gym, forgotten, at(-300));
    await hereMark(gym, forgotten, 'amy', at(-240));

    const refused: ActorIdentity[] = [
      gym.exCoach, // membership ended
      await member(gym, 'athlete'),
      await member(gym, 'parent'),
      await member(gym, 'board'),
      await member(gym, 'volunteer'),
      await member(gym, 'staff'),
      await member(gym, 'platform_owner'),
      { ...other.coach, organizationId: gym.organizationId }, // another gym's coach, naming this gym
    ];
    for (const caller of refused) {
      await expect(listOnTheFloorForStaff(caller, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    }
    // Refused first: the idle close did not run for any of them.
    expect(await runState(gym, forgotten)).toBe('in_progress');
  });

  test('a failed idle close fails the read: a run idle past 3 hours is never shown', async () => {
    const gym = await newGym('close-fails');
    await addAthlete(gym, 'amy', 'Amy');
    const forgotten = await liveRun(gym, gym.coach);
    await setRunStart(gym, forgotten, at(-300));
    await hereMark(gym, forgotten, 'amy', at(-240));

    mockFailTransactions = true;
    await expect(listOnTheFloorForStaff(gym.coach, NOW)).rejects.toThrow('injected failure');
    mockFailTransactions = false;
    expect(await runState(gym, forgotten)).toBe('in_progress');

    // Once the close can run, the run is settled before the read, and she is not on the line.
    expect(names(await listOnTheFloorForStaff(gym.coach, NOW))).toEqual([]);
    expect(await runState(gym, forgotten)).toBe('abandoned');
  });

  test.each([
    ['the run marks', /from pilot\.session_run_athletes m/],
    ['the register', /from pilot\.scheduler_attendance sa/],
    ['the roster', /from pilot\.athletes/],
  ])('when the read of %s fails, the whole read fails: never a list from the other source alone', async (_label, statement) => {
    const gym = await newGym('half-fails');
    await addAthlete(gym, 'amy', 'Amy');
    await addAthlete(gym, 'bo', 'Bo');
    const open = await liveRun(gym, gym.coach);
    await setRunStart(gym, open, at(-30));
    await hereMark(gym, open, 'amy', at(-20));
    await addClass(gym, 'k-now', TODAY, '14:00');
    await registerMark(gym, 'k-now', 'bo', 'present', at(-60));
    expect(names(await listOnTheFloorForStaff(gym.coach, NOW))).toEqual(['Amy', 'Bo']);

    mockFailQuery = statement;
    await expect(listOnTheFloorForStaff(gym.coach, NOW)).rejects.toThrow('injected failure');
  });
});
