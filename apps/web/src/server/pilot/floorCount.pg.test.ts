// Real PostgreSQL-backed test for floorCount.ts and gymTvs.ts's listLiveTvRounds (lane W4-3, FN-4a;
// GO on #2192, 7206014991). './db' is mocked to route into the embedded server, so the modules' real
// SQL runs against pilot.scheduler_attendance, pilot.scheduler_classes, pilot.athletes, pilot.gym_tvs,
// pilot.session_script_runs and pilot.round_timers built by the full schema, and the real idle close
// settles runs in it.
//
// What it shows:
//   - the count is the line's own rule (QD A): today's gym day, a family's mark from its class's
//     start, a staff mark from when written; never a cancelled class, a deleted athlete, an absent or
//     excused mark, another day or another gym;
//   - the board's floor holds a live count (flag 3): 0 and 4 are suppressed, 5 shows;
//   - a round comes only from a session a TV shows (QE A), and a forgotten run never shows one: the
//     throwing idle close runs first, and a failed close fails the read (F13).
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
import { classesRunningNow, floored, registerTotalToday } from './floorCount';
import { listLiveTvRounds } from './gymTvs';
import { startSessionScriptRun } from './sessionScriptRuns';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-floor-count-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const DATABASE_NAME = 'ppbf_test_floor_count';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const NOW = new Date('2026-11-25T20:00:00Z'); // 15:00 at the gym (America/New_York, UTC-5 in November)
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
/** NOW plus `minutes` (negative for earlier), as an ISO timestamp. */
function at(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

interface Gym {
  organizationId: string;
  coachId: string;
}

/** A gym with one coach, who writes its classes, marks and runs. */
async function newGym(label: string): Promise<Gym> {
  gymCount += 1;
  const organizationId = `org-count-${label}-${gymCount}`;
  const coachId = `coach@${organizationId}`;
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [organizationId],
  );
  await client.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, 'coach', $2)`, [
    coachId, organizationId,
  ]);
  await client.query(
    `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'coach', true)`,
    [coachId, organizationId],
  );
  return { organizationId, coachId };
}

async function addAthletes(gym: Gym, ids: readonly string[], { deleted = false } = {}) {
  for (const athleteId of ids) {
    await client.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
          coach_id, created_at, updated_at, deleted_at)
       values ($1, $2, $2, '2012-01-01', '100', 'active', 'contact', true, $3, now(), now(), $4)`,
      [gym.organizationId, athleteId, gym.coachId, deleted ? new Date() : null],
    );
  }
}

/** A class at `startLocal` gym time on `day`, one hour long. Its title is its id; its room "Ring 1". */
async function addClass(gym: Gym, classId: string, day: string, startLocal: string, status: 'open' | 'full' | 'cancelled' = 'open') {
  await client.query(
    `insert into pilot.scheduler_classes
       (organization_id, class_id, title, start_at, end_at, location, capacity,
        scheduled_by_account_id, coach_account_id, status)
     values ($1, $2, $2,
             ($3 || ' ' || $4)::timestamp at time zone 'America/New_York',
             ($3 || ' ' || $4)::timestamp at time zone 'America/New_York' + interval '1 hour',
             'Ring 1', 20, $5, $5, $6)`,
    [gym.organizationId, classId, day, startLocal, gym.coachId, status],
  );
}

type MarkBy = 'coach' | 'self' | 'parent' | 'old_parent';

/** A register mark written at `writtenAt` by `by` (the method and role the scheduler records for it). */
async function mark(
  gym: Gym, classId: string, athleteId: string, status: 'present' | 'absent' | 'excused', writtenAt: string, by: MarkBy = 'coach',
) {
  const [method, role] = {
    coach: ['coach_override', 'coach'],
    self: ['self', 'athlete'],
    parent: ['parent', 'parent'],
    old_parent: ['coach_override', 'parent'],
  }[by];
  await client.query(
    `insert into pilot.scheduler_attendance
       (organization_id, attendance_id, class_id, athlete_id, status, method,
        checked_in_by_role, checked_in_by_account_id, checked_in_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $9::timestamptz)`,
    [gym.organizationId, `sa-${classId}-${athleteId}`, classId, athleteId, status, method, role, gym.coachId, writtenAt],
  );
}

/** A paired TV named `name`, pointing at `runId` (or at nothing). */
async function addTv(gym: Gym, tvId: string, name: string, runId: string | null) {
  await client.query(
    `insert into pilot.gym_tvs (organization_id, tv_id, tv_name, device_key_hash, paired_at, current_run_id)
     values ($1, $2, $3, $4, now(), $5)`,
    [gym.organizationId, tvId, name, `key-${gym.organizationId}-${tvId}`, runId],
  );
}

/**
 * A round clock on `runId`: 60-second rounds, 30 seconds' rest, 5 rounds. A running clock started
 * `secondsAgo` before the database's clock (so the round it derives is fixed); `activityAt` is when the
 * clock was set up and last changed, which the idle close reads.
 */
async function addTimer(
  gym: Gym, runId: string, { state = 'running' as 'running' | 'paused', secondsAgo = 90, activityAt = at(-10) } = {},
) {
  await client.query(
    `insert into pilot.round_timers
       (organization_id, run_id, round_seconds, rest_seconds, rounds_total, state, started_at, paused_at,
        configured_by_account_id, created_at, updated_at)
     values ($1, $2, 60, 30, 5, $3, now() - make_interval(secs => $4), case when $3 = 'paused' then now() end,
             $5, $6::timestamptz, $6::timestamptz)`,
    [gym.organizationId, runId, state, secondsAgo, gym.coachId, activityAt],
  );
}

async function setRun(gym: Gym, runId: string, { startedAt, shown }: { startedAt: string; shown: boolean }) {
  await client.query(
    `update pilot.session_script_runs set started_at = $3::timestamptz, show_on_wall = $4
      where organization_id = $1 and run_id = $2`,
    [gym.organizationId, runId, startedAt, shown],
  );
}

async function runState(gym: Gym, runId: string): Promise<string> {
  const { rows } = await client.query<{ run_state: string }>(
    'select run_state from pilot.session_script_runs where organization_id = $1 and run_id = $2',
    [gym.organizationId, runId],
  );
  return rows[0].run_state;
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

describe('floored: the board floor on a live count (flag 3)', () => {
  test('0 to 4 are suppressed, live or not; 5 and up show', () => {
    expect(floored(0)).toEqual({ status: 'insufficient_data', count: null });
    expect(floored(1)).toEqual({ status: 'insufficient_data', count: null });
    expect(floored(4)).toEqual({ status: 'insufficient_data', count: null });
    expect(floored(5)).toEqual({ status: 'available', count: 5 });
    expect(floored(12)).toEqual({ status: 'available', count: 12 });
  });

  test('anything that is not a whole count is suppressed too, never shown', () => {
    expect(floored(Number.NaN)).toEqual({ status: 'insufficient_data', count: null });
    expect(floored(5.5)).toEqual({ status: 'insufficient_data', count: null });
  });
});

describe('the register count on a real database (QD A: the line\'s own rule)', () => {
  test('classes running now, each with its own count, and the gym total', async () => {
    const gym = await newGym('count');
    const other = await newGym('other');
    await addAthletes(gym, ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9', 'a10', 'a11', 'a12', 'a13']);
    await addAthletes(gym, ['gone'], { deleted: true });
    await addAthletes(other, ['o1', 'o2', 'o3', 'o4', 'o5', 'o6']);

    await addClass(gym, 'early-bag-work', TODAY, '14:30'); // running: 14:30 to 15:30
    await addClass(gym, 'full-sparring', TODAY, '14:45', 'full'); // running; full is not cancelled
    await addClass(gym, 'called-off', TODAY, '14:30', 'cancelled'); // would be running; cancelled
    await addClass(gym, 'later-youth', TODAY, '17:00'); // not started
    await addClass(gym, 'noon-class', TODAY, '12:00'); // ended at 13:00
    await addClass(gym, 'yesterday', '2026-11-24', '14:30');
    await addClass(other, 'other-gym', TODAY, '14:30');

    // early-bag-work: three count.
    await mark(gym, 'early-bag-work', 'a1', 'present', at(-20)); // a staff mark
    await mark(gym, 'early-bag-work', 'a2', 'present', at(-40), 'self'); // the athlete's own, before the start; the class has started
    await mark(gym, 'early-bag-work', 'a3', 'absent', at(-20));
    await mark(gym, 'early-bag-work', 'a4', 'excused', at(-20));
    await mark(gym, 'early-bag-work', 'a5', 'present', at(5)); // written after this read
    await mark(gym, 'early-bag-work', 'gone', 'present', at(-20)); // a deleted athlete
    await mark(gym, 'early-bag-work', 'a6', 'present', at(-25), 'old_parent'); // a parent's mark, older form; class started
    // full-sparring: one counts (a1 again: per class, not distinct across classes).
    await mark(gym, 'full-sparring', 'a1', 'present', at(-10));
    // called-off: never counted.
    await mark(gym, 'called-off', 'a7', 'present', at(-20));
    // later-youth: a family's mark before the start does not count yet; a staff mark counts from when written.
    await mark(gym, 'later-youth', 'a8', 'present', at(-60), 'parent');
    await mark(gym, 'later-youth', 'a9', 'present', at(-60), 'self');
    await mark(gym, 'later-youth', 'a10', 'present', at(-15));
    await mark(gym, 'later-youth', 'a13', 'present', at(-60), 'old_parent'); // a parent's mark in the older form: also held
    // noon-class: ended, but today's gym day, so it counts in the total.
    await mark(gym, 'noon-class', 'a11', 'present', at(-170));
    // yesterday and the other gym: never counted here.
    await mark(gym, 'yesterday', 'a12', 'present', at(-1460));
    await mark(other, 'other-gym', 'o1', 'present', at(-20));

    const classes = await classesRunningNow(gym.organizationId, NOW);
    expect(classes).toEqual([
      {
        title: 'early-bag-work',
        start_at: '2026-11-25T19:30:00.000Z',
        end_at: '2026-11-25T20:30:00.000Z',
        room: 'Ring 1',
        here: 3,
      },
      {
        title: 'full-sparring',
        start_at: '2026-11-25T19:45:00.000Z',
        end_at: '2026-11-25T20:45:00.000Z',
        room: 'Ring 1',
        here: 1,
      },
    ]);
    for (const each of classes) expect(Object.keys(each).sort()).toEqual(['end_at', 'here', 'room', 'start_at', 'title']);

    // a1, a2, a6 (early-bag-work), a10 (later-youth, a staff mark), a11 (noon-class): five different athletes.
    expect(await registerTotalToday(gym.organizationId, NOW)).toBe(5);
    expect(await registerTotalToday(other.organizationId, NOW)).toBe(1);
  });

  test('a family\'s mark counts from its class\'s start, and at the class\'s end the class is no longer running', async () => {
    const gym = await newGym('start');
    await addAthletes(gym, ['p1', 'p2']);
    await addClass(gym, 'evening', TODAY, '15:10'); // starts ten minutes after NOW
    await mark(gym, 'evening', 'p1', 'present', at(-30), 'parent');
    await mark(gym, 'evening', 'p2', 'present', at(-30), 'self');

    expect(await registerTotalToday(gym.organizationId, NOW)).toBe(0);
    expect(await classesRunningNow(gym.organizationId, NOW)).toEqual([]);

    const atStart = new Date('2026-11-25T20:10:00Z');
    expect(await registerTotalToday(gym.organizationId, atStart)).toBe(2);
    expect((await classesRunningNow(gym.organizationId, atStart)).map((each) => [each.title, each.here])).toEqual([['evening', 2]]);

    const atEnd = new Date('2026-11-25T21:10:00Z');
    expect(await classesRunningNow(gym.organizationId, atEnd)).toEqual([]);
    expect(await registerTotalToday(gym.organizationId, atEnd)).toBe(2); // still today's gym day
  });

  test('an empty gym counts 0, which the board floor suppresses', async () => {
    const gym = await newGym('empty');
    expect(await registerTotalToday(gym.organizationId, NOW)).toBe(0);
    expect(floored(await registerTotalToday(gym.organizationId, NOW))).toEqual({ status: 'insufficient_data', count: null });
    expect(await classesRunningNow(gym.organizationId, NOW)).toEqual([]);
  });

  test('a failed statement fails the read, never a zero', async () => {
    const gym = await newGym('fail');
    mockFailQuery = /count\(distinct sa\.athlete_id\)::int as total/;
    await expect(registerTotalToday(gym.organizationId, NOW)).rejects.toThrow('injected failure');
    mockFailQuery = /from pilot\.scheduler_classes c\n\s*where c\.organization_id = \$1/;
    await expect(classesRunningNow(gym.organizationId, NOW)).rejects.toThrow('injected failure');
  });
});

describe('listLiveTvRounds on a real database (QE A, F13)', () => {
  test('only a session a TV shows, with a round clock; a forgotten run is settled first and shows no round', async () => {
    const gym = await newGym('rounds');
    const other = await newGym('rounds-other');
    // Start every run first: a run start sweeps idle runs on the real clock.
    const ring = (await startSessionScriptRun(gym.organizationId, gym.coachId, {})).run_id;
    // One live run per coach, so each other run is a second coach's.
    const coaches = ['c2', 'c3', 'c4', 'c5', 'c6'].map((name) => `${name}@${gym.organizationId}`);
    for (const id of coaches) {
      await client.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, 'coach', $2)`, [id, gym.organizationId]);
      await client.query(
        `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'coach', true)`,
        [id, gym.organizationId],
      );
    }
    const runs: string[] = [];
    for (const id of coaches) runs.push((await startSessionScriptRun(gym.organizationId, id, {})).run_id);
    const [pausedId, hiddenId, noClockId, offTvId, forgottenId] = runs;
    const otherRun = (await startSessionScriptRun(other.organizationId, other.coachId, {})).run_id;

    for (const id of [ring, pausedId, hiddenId, noClockId, offTvId]) await setRun(gym, id, { startedAt: at(-10), shown: true });
    await setRun(gym, hiddenId, { startedAt: at(-10), shown: false }); // the coach chose not to show it
    await setRun(gym, forgottenId, { startedAt: at(-240), shown: true }); // idle past three hours
    await setRun(other, otherRun, { startedAt: at(-10), shown: true });

    await addTimer(gym, ring, { secondsAgo: 90 }); // 90 s into 60 s rounds with 30 s rest: round 2, work
    await addTimer(gym, pausedId, { state: 'paused', secondsAgo: 20 });
    await addTimer(gym, hiddenId);
    await addTimer(gym, offTvId);
    await addTimer(gym, forgottenId, { secondsAgo: 60, activityAt: at(-240) });
    await addTimer(other, otherRun);

    await addTv(gym, 'tv-1', 'Ring TV', ring);
    await addTv(gym, 'tv-2', 'Bag TV', pausedId);
    await addTv(gym, 'tv-3', 'Hidden TV', hiddenId);
    await addTv(gym, 'tv-4', 'Plain TV', noClockId); // a session with no round clock
    await addTv(gym, 'tv-5', 'Old TV', forgottenId);
    await addTv(gym, 'tv-6', 'Idle TV', null); // a TV showing nothing
    await addTv(other, 'tv-1', 'Other gym TV', otherRun);

    const rounds = await listLiveTvRounds(gym.organizationId, NOW);
    expect(rounds).toEqual([
      { tv_name: 'Bag TV', phase: 'work', round: 1, rounds_total: 5, is_paused: true },
      { tv_name: 'Ring TV', phase: 'work', round: 2, rounds_total: 5, is_paused: false },
    ]);
    for (const each of rounds) expect(Object.keys(each).sort()).toEqual(['is_paused', 'phase', 'round', 'rounds_total', 'tv_name']);

    // The forgotten run was settled by the close before the read; the shown ones stay live.
    expect(await runState(gym, forgottenId)).toBe('abandoned');
    expect(await runState(gym, ring)).toBe('in_progress');
    expect(await runState(gym, offTvId)).toBe('in_progress');
  });

  test('a failed idle close fails the read', async () => {
    const gym = await newGym('close-fails');
    mockFailTransactions = true;
    await expect(listLiveTvRounds(gym.organizationId, NOW)).rejects.toThrow('injected failure');
  });
});
