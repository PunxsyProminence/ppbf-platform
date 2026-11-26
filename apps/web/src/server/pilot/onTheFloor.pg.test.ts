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
/** When set, runs once just before the first query whose SQL matches (a change committed mid-read). */
let mockBeforeQuery: { match: RegExp; run: () => Promise<void> } | null = null;

function mockInjectedFailure(): Error {
  return Object.assign(new Error('injected failure for the test'), { code: 'XX000' });
}

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    if (mockFailQuery?.test(text)) throw mockInjectedFailure();
    if (mockBeforeQuery?.match.test(text)) {
      const hook = mockBeforeQuery;
      mockBeforeQuery = null;
      await hook.run();
    }
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
import { listOnTheFloorForStaff, onTheFloorForFamily } from './onTheFloor';
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

async function addAthlete(
  gym: Gym, athleteId: string, name: string, { deleted = false, dob = '2012-01-01' as string | null } = {},
) {
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
        coach_id, created_at, updated_at, deleted_at)
     values ($1, $2, $3, $6::date, '100', 'active', 'contact', true, $4, now(), now(), $5)`,
    [gym.organizationId, athleteId, name, gym.coach.accountId, deleted ? new Date() : null, dob],
  );
}

/** A parent account with an active membership, backing one pilot.parents row linked to these athletes. */
async function parentOf(gym: Gym, athleteIds: readonly string[]): Promise<ActorIdentity> {
  const parent = await member(gym, 'parent');
  const parentId = `parent-row-${parent.accountId}`;
  await client.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name) values ($1, $2, $3, 'A parent')`,
    [gym.organizationId, parentId, parent.accountId],
  );
  for (const athleteId of athleteIds) {
    await client.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete) values ($1, $2, $3, 'parent')`,
      [gym.organizationId, parentId, athleteId],
    );
  }
  return parent;
}

/** An athlete's own session: the athlete role, and the athlete record it is linked to (or none). */
function athleteAccount(gym: Gym, athleteId: string | null): ActorIdentity {
  return { ...actor(gym.organizationId, `athlete-${athleteId ?? 'none'}@${gym.organizationId}`, 'athlete'), athleteId };
}

/** A class at `startLocal` gym time on `day` (one hour long). */
async function addClass(gym: Gym, classId: string, day: string, startLocal: string, { cancelled = false, full = false } = {}) {
  await client.query(
    `insert into pilot.scheduler_classes
       (organization_id, class_id, title, start_at, end_at, location, capacity,
        scheduled_by_account_id, coach_account_id, status)
     values ($1, $2, $2,
             ($3 || ' ' || $4)::timestamp at time zone 'America/New_York',
             ($3 || ' ' || $4)::timestamp at time zone 'America/New_York' + interval '1 hour',
             'Main floor', 20, $5, $5, $6)`,
    [gym.organizationId, classId, day, startLocal, gym.coach.accountId, cancelled ? 'cancelled' : full ? 'full' : 'open'],
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
      ['wes', 'Wes'], ['xia', 'Xia'], ['yan', 'Yan'], ['zed', 'Zed'], ['pia', 'Pia'], ['ray', 'Ray'], ['zoe', 'Zoe'],
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
    await hereMark(gym, sentHome, 'dot', at(-20)); // an Absent written after the run began but BEFORE her mark does not take her off
    await registerMark(gym, 'k-sent-home', 'dot', 'absent', at(-25));
    await hereMark(gym, open, 'pia', at(-20)); // a later Absent on another class does not touch an open-gym mark
    await hereMark(gym, sentHome, 'ray', at(-20)); // nor a mark on a run tied to a different class
    // (both Absents below are on k-early, written after the marks)
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
    await registerMark(gym, 'k-early', 'pia', 'absent', at(-10)); // see pia above: she stays on by her run mark
    await registerMark(gym, 'k-early', 'ray', 'absent', at(-10)); // see ray above: he stays on by his run mark
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
    await client.query( // nor does an activity log row alone (FN-0 F9; the convention test also pins that the file names none)
      `insert into pilot.activity_log
         (organization_id, activity_id, person_account_id, athlete_id, activity_domain, activity_type, occurred_on,
          duration_minutes, attendance_status, capture_method, recorded_by_role, recorded_by_account_id)
       values ($1, 'al-zoe', $2, 'zoe', 'boxing_training', 'technical_session', $3::date, 60, 'present', 'coach_override', 'coach', $2)`,
      [gym.organizationId, gym.coach.accountId, TODAY],
    );

    expect(await runState(gym, forgotten)).toBe('in_progress');
    const line = await listOnTheFloorForStaff(gym.coach, NOW);
    expect(line.day).toBe(TODAY);
    expect(names(line)).toEqual(['Ada', 'Dot', 'Eli', 'Fay', 'Kim', 'Lou', 'Pam', 'Pia', 'Quo', 'Ray', 'Tia', 'Yan']);
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
    expect(names(await listOnTheFloorForStaff(gym.coach, new Date(Date.parse('2026-11-25T21:59:00Z'))))).toEqual([]); // 16:59
    expect(names(await listOnTheFloorForStaff(gym.coach, new Date(Date.parse('2026-11-25T22:00:00Z'))))).toEqual(['Amy']); // 17:00
    expect(names(await listOnTheFloorForStaff(gym.coach, new Date(Date.parse('2026-11-26T04:59:00Z'))))).toEqual(['Amy']); // 23:59
    expect(names(await listOnTheFloorForStaff(gym.coach, new Date(Date.parse('2026-11-26T05:00:00Z'))))).toEqual([]); // the next gym day
  });

  test('a staff mark counts from when it is written to the end of the gym day, for a class at either end of the day', async () => {
    const gym = await newGym('edges');
    await addAthlete(gym, 'amy', 'Amy');
    await addAthlete(gym, 'bo', 'Bo');
    await addClass(gym, 'k-first', TODAY, '00:30'); // 05:30 UTC
    await addClass(gym, 'k-last', TODAY, '23:30'); // 04:30 UTC on the 26th
    await registerMark(gym, 'k-first', 'amy', 'present', '2026-11-25T06:00:00Z'); // 01:00 at the gym
    await registerMark(gym, 'k-last', 'bo', 'present', '2026-11-25T05:45:00Z'); // 00:45 at the gym, for the 23:30 class
    // 01:00: Bo's class is 22.5 hours away, and his staff mark counts from when it was written.
    expect(names(await listOnTheFloorForStaff(gym.coach, new Date(Date.parse('2026-11-25T06:00:00Z'))))).toEqual(['Amy', 'Bo']);
    // 23:59: Amy's class began 23.5 hours ago, and her mark still counts to the end of the gym day.
    expect(names(await listOnTheFloorForStaff(gym.coach, new Date(Date.parse('2026-11-26T04:59:00Z'))))).toEqual(['Amy', 'Bo']);
  });

  test('the gym day follows daylight saving: in July a class just after local midnight is that day\'s, one just before is the day before\'s', async () => {
    const gym = await newGym('summer');
    const summerNoon = new Date(Date.parse('2026-07-15T16:00:00Z')); // 12:00 at the gym (UTC-4 in July)
    await addAthlete(gym, 'amy', 'Amy');
    await addAthlete(gym, 'bo', 'Bo');
    await addClass(gym, 'k-just-after', '2026-07-15', '00:30'); // 04:30 UTC on the 15th
    await addClass(gym, 'k-just-before', '2026-07-14', '23:30'); // 03:30 UTC on the 15th
    await registerMark(gym, 'k-just-after', 'amy', 'present', '2026-07-15T05:00:00Z');
    await registerMark(gym, 'k-just-before', 'bo', 'present', '2026-07-15T04:00:00Z');
    const line = await listOnTheFloorForStaff(gym.coach, summerNoon);
    expect(line.day).toBe('2026-07-15');
    expect(names(line)).toEqual(['Amy']);
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

describe('onTheFloorForFamily on a real database (FN-2)', () => {
  /*
   * One gym, read at NOW (15:00 at the gym). Every child but Kim and the other
   * parent's child is linked to parent A.
   *   Reg   a staff mark on a class that started at 14:00            counts
   *   Run   a mark on an untied live run                              counts (FN-0 F1: the new fact)
   *   Cxr   a present mark on a cancelled class                       staff only (FN0-Q1 A)
   *   Cxu   a mark on a run tied to a cancelled class                 staff only (flag 9)
   *   Tie   a mark on a run tied to an open class, no register mark   counts (only a cancelled tie is left out)
   *   Ful   a present mark on a full class                            counts (full is not cancelled)
   *   Fru   a mark on a run tied to a full class                      counts
   *   Exc   a run mark, then Excused on the run's class               nobody (FN0-Q6 A)
   *   Eve   a parent's own mark on the 18:00 class                    nobody yet (FN0-Q2 A)
   *   Non   no mark                                                   nobody
   *   Adu   18 or over, marked                                        staff, and herself; not the parent (F6)
   *   Del   deleted, marked                                           nobody
   *   Kim   marked, linked to parent B only                           staff, and parent B
   * F6's "no date of birth reads as a minor" cannot be built as a row: pilot.athletes.dob is NOT NULL
   * (infra/azure/pilot_slice_postgres.sql:88), so that rule lives in isMinor alone.
   */
  async function familyGym(label: string) {
    const gym = await newGym(label);
    for (const [id, name, dob] of [
      ['reg', 'Reg', '2012-01-01'], ['run', 'Run', '2012-01-01'], ['cxr', 'Cxr', '2012-01-01'],
      ['cxu', 'Cxu', '2012-01-01'], ['tie', 'Tie', '2012-01-01'], ['ful', 'Ful', '2012-01-01'], ['fru', 'Fru', '2012-01-01'],
      ['exc', 'Exc', '2012-01-01'], ['eve', 'Eve', '2012-01-01'], ['non', 'Non', '2012-01-01'],
      ['adu', 'Adu', '2000-01-01'], ['kim', 'Kim', '2012-01-01'],
    ] as const) {
      await addAthlete(gym, id, name, { dob });
    }
    await addAthlete(gym, 'del', 'Del', { deleted: true });

    const [coachB, coachC, coachD, coachE] = [
      await member(gym, 'coach'), await member(gym, 'coach'), await member(gym, 'coach'), await member(gym, 'coach'),
    ];
    // Every run is started before any clock is set: a start sweeps idle runs on the real clock.
    const untied = await liveRun(gym, gym.coach);
    const cancelledTie = await liveRun(gym, coachB);
    const sentHome = await liveRun(gym, coachC);
    const forgotten = await liveRun(gym, coachD); // idle past 3 hours, no marks
    const fullTie = await liveRun(gym, coachE);
    for (const runId of [untied, cancelledTie, sentHome, fullTie]) await setRunStart(gym, runId, at(-30));
    await setRunStart(gym, forgotten, at(-300));

    await addClass(gym, 'f-now', TODAY, '14:00');
    await addClass(gym, 'f-cancelled', TODAY, '13:00', { cancelled: true });
    await addClass(gym, 'f-sent-home', TODAY, '14:30');
    await addClass(gym, 'f-evening', TODAY, '18:00');
    await addClass(gym, 'f-full', TODAY, '14:00', { full: true });
    await tieRun(gym, cancelledTie, 'f-cancelled');
    await tieRun(gym, sentHome, 'f-sent-home');
    await tieRun(gym, fullTie, 'f-full');
    // Another gym's class with the same id, cancelled there: class ids are unique only per gym, so the
    // cancelled-tie check must match the run's own gym (Tie still counts).
    const twin = await newGym(`${label}-twin`);
    await addClass(twin, 'f-sent-home', TODAY, '14:30', { cancelled: true });

    for (const id of ['reg', 'adu', 'del', 'kim']) await registerMark(gym, 'f-now', id, 'present', at(-30));
    await hereMark(gym, untied, 'run', at(-20));
    await registerMark(gym, 'f-cancelled', 'cxr', 'present', at(-90));
    await hereMark(gym, cancelledTie, 'cxu', at(-20));
    await hereMark(gym, sentHome, 'exc', at(-20));
    await hereMark(gym, sentHome, 'tie', at(-20)); // the open class's register holds no mark for her
    await registerMark(gym, 'f-full', 'ful', 'present', at(-30));
    await hereMark(gym, fullTie, 'fru', at(-20));
    await registerMark(gym, 'f-sent-home', 'exc', 'excused', at(-10));
    await registerMark(gym, 'f-evening', 'eve', 'present', at(-60), 'parent');

    const parentA = await parentOf(gym, ['reg', 'run', 'cxr', 'cxu', 'tie', 'ful', 'fru', 'exc', 'eve', 'non', 'adu', 'del']);
    const parentB = await parentOf(gym, ['kim']);
    return { gym, parentA, parentB, forgotten };
  }

  const ids = (answer: { on_the_floor: readonly string[] | boolean }) => [...(answer.on_the_floor as readonly string[])].sort();

  test('a parent is answered with their own minor children who count, by id, and nothing else (F6, checks 1 to 3)', async () => {
    const { gym, parentA, parentB } = await familyGym('parents');

    const a = await onTheFloorForFamily(parentA, NOW);
    expect(Object.keys(a).sort()).toEqual(['on_the_floor', 'reader']);
    expect(a.reader).toBe('parent');
    expect(ids(a)).toEqual(['fru', 'ful', 'reg', 'run', 'tie']);
    expect(ids(await onTheFloorForFamily(parentB, NOW))).toEqual(['kim']);

    // The same gym's staff line keeps the cancelled class's mark and the run tied to it (FN0-Q1 A), the
    // adult, and the other family's child; it never had the sent-home, early or unmarked children.
    expect(names(await listOnTheFloorForStaff(gym.coach, NOW))).toEqual(['Adu', 'Cxr', 'Cxu', 'Fru', 'Ful', 'Kim', 'Reg', 'Run', 'Tie']);
  });

  test('an athlete is answered yes or no about themselves only, by the family rules', async () => {
    const { gym } = await familyGym('athletes');
    const expected: Record<string, boolean> = {
      reg: true, run: true, adu: true, kim: true, tie: true, ful: true, fru: true,
      cxr: false, cxu: false, exc: false, eve: false, non: false, del: false,
    };
    for (const [id, onFloor] of Object.entries(expected)) {
      const answer = await onTheFloorForFamily(athleteAccount(gym, id), NOW);
      expect({ id, answer }).toEqual({ id, answer: { reader: 'athlete', on_the_floor: onFloor } });
    }
  });

  test('a parent of no live minor child, or one naming another gym, gets an empty answer and nothing is settled', async () => {
    const { gym, parentA, forgotten } = await familyGym('empty-scope');

    const adultsAndDeletedOnly = await parentOf(gym, ['adu', 'del']);
    const unlinked = await parentOf(gym, []);
    const other = await newGym('empty-scope-other');
    for (const parent of [adultsAndDeletedOnly, unlinked, { ...parentA, organizationId: other.organizationId }]) {
      expect(await onTheFloorForFamily(parent, NOW)).toEqual({ reader: 'parent', on_the_floor: [] });
    }
    expect(await runState(gym, forgotten)).toBe('in_progress');

    // A parent with a child in scope does run the close first, as the staff line does (F13).
    expect(ids(await onTheFloorForFamily(parentA, NOW))).toEqual(['fru', 'ful', 'reg', 'run', 'tie']);
    expect(await runState(gym, forgotten)).toBe('abandoned');
  });

  test('a guardian link removed after the scope is read, before the line is counted, is not counted (App Overwatch on #2192)', async () => {
    const { gym, parentA } = await familyGym('link-removed');
    expect(ids(await onTheFloorForFamily(parentA, NOW))).toEqual(['fru', 'ful', 'reg', 'run', 'tie']);

    // The links go the moment the first count statement is sent: guardianAthleteIds has already read
    // them, so only a check inside each count statement can see that they are gone. Two more children
    // turn adult at the same moment (one counted through the register, one through a run), so the 18
    // rule is applied to the date of birth each statement returns, not only to the earlier scope.
    mockBeforeQuery = {
      match: /from pilot\.session_run_athletes m|from pilot\.scheduler_attendance sa/,
      // One statement, so it is queued on the client before either count statement is sent.
      run: async () => {
        await client.query(
          `with unlinked as (
             delete from pilot.guardian_links where organization_id = $1 and athlete_id = any($2::text[]) returning 1
           )
           update pilot.athletes set dob = '2000-01-01' where organization_id = $1 and athlete_id = any($3::text[])`,
          [gym.organizationId, ['reg', 'run', 'tie'], ['ful', 'fru']],
        );
      },
    };
    try {
      expect(ids(await onTheFloorForFamily(parentA, NOW))).toEqual([]);
      expect(mockBeforeQuery).toBeNull();
    } finally {
      mockBeforeQuery = null;
    }
    // The athlete's own line and the staff line are not the guardian's, and do not change.
    expect(await onTheFloorForFamily(athleteAccount(gym, 'reg'), NOW)).toEqual({ reader: 'athlete', on_the_floor: true });
    expect(names(await listOnTheFloorForStaff(gym.coach, NOW))).toContain('Reg');
  });

  test('anyone but a parent, or an athlete linked to a record, is refused (403) before anything is read or closed', async () => {
    const gym = await newGym('family-refused');
    await addAthlete(gym, 'amy', 'Amy');
    const forgotten = await liveRun(gym, gym.coach);
    await setRunStart(gym, forgotten, at(-300));
    await hereMark(gym, forgotten, 'amy', at(-240));

    const refused: ActorIdentity[] = [
      gym.coach,
      gym.admin,
      { ...gym.admin, role: 'admin' },
      await member(gym, 'board'),
      await member(gym, 'volunteer'),
      await member(gym, 'staff'),
      await member(gym, 'platform_owner'),
      athleteAccount(gym, null), // an athlete account with no athlete record (FN-0 check 8)
      { ...(await member(gym, 'parent')), accountId: '' }, // a parent with no account id: refused, never unchecked
    ];
    for (const caller of refused) {
      await expect(onTheFloorForFamily(caller, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await runState(gym, forgotten)).toBe('in_progress');
  });

  test.each([
    ['the idle close', null],
    ['the run marks', /from pilot\.session_run_athletes m/],
    ['the register', /from pilot\.scheduler_attendance sa/],
    ['the roster', /from pilot\.athletes/],
  ])('when %s fails, the family read fails: never an answer from part of it', async (_label, statement) => {
    const { parentA, gym } = await familyGym('family-fails');
    if (statement) mockFailQuery = statement;
    else mockFailTransactions = true;
    try {
      await expect(onTheFloorForFamily(parentA, NOW)).rejects.toThrow('injected failure');
      await expect(onTheFloorForFamily(athleteAccount(gym, 'reg'), NOW)).rejects.toThrow('injected failure');
    } finally {
      mockFailQuery = null;
      mockFailTransactions = false;
    }
  });
});
