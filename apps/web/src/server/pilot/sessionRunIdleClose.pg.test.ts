// Real PostgreSQL-backed suite for OD-2026-10-21-001 ruling 2 (pilot decision D2; Jason, "A: Yes,
// after 3 hours (Rec.)"): a coach's live session with no activity for three hours is settled as
// ABANDONED, ended 3 hours after the last activity, and drops off the paired gym TV
// (sessionScriptRuns.ts closeIdleSessionRuns, called by the readers).
//
// Found live on 2026-10-19: a plain session sat in_progress for 29h 33m, still set to show on the
// TV, until it was ended by hand. Every case below that expects a close fails on a main without
// the sweep: the forgotten run is still returned as live.
//
// What needs a real database to prove: the activity signals are read from the tables that hold
// them (a recent presence mark, round clock change or staff note keeps a run open; an old one does
// not), the settled row satisfies the run-state checks (ended_at = last activity + 3 hours, an
// open pause banked, off the TV), a settled run is never touched, and the sweep is scoped to one
// organization. Runs against the whole production schema (scripts/lib/full-schema.mjs) on the
// disposable local embedded Postgres the other suites use. It NEVER connects to production or
// staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot load an ES module
   here. Building it through Function keeps a real dynamic import in the emitted code. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

let activeClient: Client | null = null;
let activeConnectionString: string | null = null;

jest.mock('./db', () => ({
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeConnectionString) throw new Error('test bug: no active embedded database');
    const own = new Client({ connectionString: activeConnectionString });
    await own.connect();
    try {
      await own.query('BEGIN');
      try {
        const result = await fn({ query: (text: string, values: unknown[]) => own.query(text, values) });
        await own.query('COMMIT');
        return result;
      } catch (error) {
        await own.query('ROLLBACK').catch(() => {});
        throw error;
      }
    } finally {
      await own.end();
    }
  }),
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
}));

import { listGymTvs, mintGymTvPairCode, readGymTvSession, redeemGymTvPairCode, sendRunToGymTv } from './gymTvs';
import {
  getLiveRunForCoach,
  listSettledRunsForOrganization,
  setSessionScriptRunShowOnWall,
  startSessionScriptRun,
} from './sessionScriptRuns';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-run-idle-close-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const DATABASE_NAME = 'ppbf_test_session_run_idle_close';

// The words the run carries when the app closed it (PROPOSED copy, sessionScriptRuns.ts).
const NOTE = 'Closed automatically after 3 hours with no recorded activity.';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
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

interface Gym {
  organizationId: string;
  coach: string;
  otherCoach: string;
  athlete: string;
}

async function newGym(label: string): Promise<Gym> {
  gymCount += 1;
  const organizationId = `org-idle-${label}-${gymCount}`;
  const coach = `coach@${organizationId}`;
  const otherCoach = `coach2@${organizationId}`;
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [organizationId],
  );
  for (const accountId of [coach, otherCoach]) {
    await client.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, 'coach', $2)`, [
      accountId,
      organizationId,
    ]);
    await client.query(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag) values ($1, $2, 'coach', true)`,
      [accountId, organizationId],
    );
  }
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
        coach_id, created_at, updated_at)
     values ($1, 'athlete-ada', 'Ada Reyes', '2012-01-01', '100', 'active', 'contact', true, $2, now(), now())`,
    [organizationId, coach],
  );
  return { organizationId, coach, otherCoach, athlete: 'athlete-ada' };
}

/** A live plain session for this coach, started `hoursAgo` hours ago. */
async function liveRunStarted(gym: Gym, hoursAgo: number, coach = gym.coach): Promise<string> {
  const run = await startSessionScriptRun(gym.organizationId, coach, {});
  await client.query(
    `update pilot.session_script_runs set started_at = now() - make_interval(secs => $2) where run_id = $1`,
    [run.run_id, Math.round(hoursAgo * 3600)],
  );
  return run.run_id;
}

async function runRow(runId: string) {
  const { rows } = await client.query<{
    run_state: string;
    started_at: Date;
    ended_at: Date | null;
    show_on_wall: boolean;
    paused_at: Date | null;
    paused_seconds: number;
    current_block_id: string | null;
    deviation_note: string;
    idle_end_hours: string | null;
  }>(
    `select run_state, started_at, ended_at, show_on_wall, paused_at, paused_seconds, current_block_id,
            deviation_note, round(extract(epoch from (ended_at - started_at)) / 3600.0, 4)::text as idle_end_hours
       from pilot.session_script_runs where run_id = $1`,
    [runId],
  );
  return rows[0];
}

async function markPresent(gym: Gym, runId: string, minutesAgo: number) {
  await client.query(
    `insert into pilot.session_run_athletes (organization_id, run_id, athlete_id, marked_by_account_id, marked_by_role, marked_at)
     values ($1, $2, $3, $4, 'coach', now() - make_interval(mins => $5))`,
    [gym.organizationId, runId, gym.athlete, gym.coach, minutesAgo],
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  applyFullSchema = helper.applyFullSchema as typeof applyFullSchema;

  const adminClient = new Client({ connectionString: connectionStringFor('postgres') });
  await adminClient.connect();
  await adminClient.query(`drop database if exists ${DATABASE_NAME}`);
  await adminClient.query(`create database ${DATABASE_NAME}`);
  await adminClient.end();

  client = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
  await client.connect();
  await applyFullSchema(client, { infraDir: INFRA_DIR });
  activeClient = client;
  activeConnectionString = connectionStringFor(DATABASE_NAME);
});

afterAll(async () => {
  activeClient = null;
  activeConnectionString = null;
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
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
});

// The readers swallow a failed sweep (sweepIdleRuns) so a screen never goes down with it. That
// would also let a "stays open" case pass with the sweep broken, so every case here proves the
// sweep did not fail.
let consoleError: jest.SpyInstance;
beforeEach(() => {
  consoleError = jest.spyOn(console, 'error');
});
afterEach(() => {
  expect(consoleError.mock.calls.filter(([event]) => event === 'session-run-idle-close-failed')).toEqual([]);
  consoleError.mockRestore();
});

describe('a live session idle for three hours closes itself (D2)', () => {
  test('the coach finds no live session: it is settled ABANDONED, ended at start + 3 hours, off the TV, with a note saying the app closed it', async () => {
    const gym = await newGym('forgotten');
    const runId = await liveRunStarted(gym, 0);
    await setSessionScriptRunShowOnWall(gym.organizationId, gym.coach, runId, true);
    // The 2026-10-19 case: nothing after the start, for far longer than the limit.
    await client.query(`update pilot.session_script_runs set started_at = now() - interval '29 hours 33 minutes' where run_id = $1`, [runId]);

    expect(await getLiveRunForCoach(gym.organizationId, gym.coach)).toBeNull();

    const row = await runRow(runId);
    expect(row.run_state).toBe('abandoned');
    // The moment the limit was reached, not the moment a reader noticed.
    expect(row.idle_end_hours).toBe('3.0000');
    expect(row.show_on_wall).toBe(false);
    expect(row.paused_at).toBeNull();
    expect(row.current_block_id).toBeNull();
    expect(row.deviation_note).toBe(NOTE);
  });

  test('just under three hours idle stays live; the history lists the run once it closes', async () => {
    const gym = await newGym('under');
    const runId = await liveRunStarted(gym, 2.9);
    expect((await getLiveRunForCoach(gym.organizationId, gym.coach))?.run_id).toBe(runId);
    expect((await runRow(runId)).run_state).toBe('in_progress');

    await client.query(`update pilot.session_script_runs set started_at = now() - interval '3 hours 1 minute' where run_id = $1`, [runId]);
    const history = await listSettledRunsForOrganization(gym.organizationId);
    expect(history.map((run) => [run.run_id, run.run_state, run.deviation_note])).toEqual([[runId, 'abandoned', NOTE]]);
  });

  test('a forgotten run does not block the same coach starting the next session', async () => {
    const gym = await newGym('next');
    const forgotten = await liveRunStarted(gym, 5);
    const next = await startSessionScriptRun(gym.organizationId, gym.coach, {});
    expect(next.run_id).not.toBe(forgotten);
    expect((await runRow(forgotten)).run_state).toBe('abandoned');
    expect((await runRow(next.run_id)).run_state).toBe('in_progress');
  });

  test('a presence mark one hour ago keeps a run started four hours ago open; once the mark is three hours old it closes, ended at mark + 3 hours', async () => {
    const gym = await newGym('mark');
    const runId = await liveRunStarted(gym, 4);
    await markPresent(gym, runId, 60);
    expect((await getLiveRunForCoach(gym.organizationId, gym.coach))?.run_id).toBe(runId);

    await client.query(
      `update pilot.session_run_athletes set marked_at = (select started_at from pilot.session_script_runs where run_id = $1) + interval '50 minutes'
        where run_id = $1`,
      [runId],
    );
    expect(await getLiveRunForCoach(gym.organizationId, gym.coach)).toBeNull();
    expect((await runRow(runId)).idle_end_hours).toBe('3.8333');
  });

  test('taking a mark back counts as activity too', async () => {
    const gym = await newGym('unmark');
    const runId = await liveRunStarted(gym, 5);
    await markPresent(gym, runId, 280);
    await client.query(
      `update pilot.session_run_athletes set removed_at = now() - interval '30 minutes', removed_by_account_id = $2 where run_id = $1`,
      [runId, gym.coach],
    );
    expect((await getLiveRunForCoach(gym.organizationId, gym.coach))?.run_id).toBe(runId);
  });

  test('a change to the round clock 30 minutes ago keeps the run open', async () => {
    const gym = await newGym('timer');
    const runId = await liveRunStarted(gym, 4);
    await client.query(
      `insert into pilot.round_timers
         (organization_id, run_id, round_seconds, rest_seconds, rounds_total, state, configured_by_account_id, created_at, updated_at)
       values ($1, $2, 180, 60, 3, 'ready', $3, now() - interval '4 hours', now() - interval '30 minutes')`,
      [gym.organizationId, runId, gym.coach],
    );
    expect((await getLiveRunForCoach(gym.organizationId, gym.coach))?.run_id).toBe(runId);
  });

  test('a staff note on the run 30 minutes ago keeps the run open', async () => {
    const gym = await newGym('note');
    const runId = await liveRunStarted(gym, 4);
    await markPresent(gym, runId, 230);
    await client.query(
      `insert into pilot.session_staff_notes
         (organization_id, note_id, session_id, run_id, athlete_id, author_account_id, author_role, note, created_at, updated_at)
       values ($1, gen_random_uuid(), null, $2, $3, $4, 'coach', 'Sharp today.', now() - interval '30 minutes', now() - interval '30 minutes')`,
      [gym.organizationId, runId, gym.athlete, gym.coach],
    );
    expect((await getLiveRunForCoach(gym.organizationId, gym.coach))?.run_id).toBe(runId);
  });

  test('an intervention logged against the run 30 minutes ago keeps the run open', async () => {
    const gym = await newGym('intervention');
    const runId = await liveRunStarted(gym, 4);
    await client.query(
      `insert into pilot.intervention_protocols
         (organization_id, protocol_id, lineage_id, title, target_problem, hypothesis, intervention_description,
          expected_outcome, created_by_account_id)
       values ($1, 'proto-1', 'proto-1', 'Guard reset', 'Hands drop', 'Cue helps', 'Cue the guard', 'Hands stay up', $2)`,
      [gym.organizationId, gym.coach],
    );
    await client.query(
      `insert into pilot.intervention_executions
         (organization_id, execution_id, lineage_id, athlete_id, protocol_id, protocol_version, session_run_id,
          recorded_by_account_id, created_at, updated_at)
       values ($1, 'exec-1', 'exec-1', $2, 'proto-1', 1, $3, $4, now() - interval '30 minutes', now() - interval '30 minutes')`,
      [gym.organizationId, gym.athlete, runId, gym.coach],
    );
    expect((await getLiveRunForCoach(gym.organizationId, gym.coach))?.run_id).toBe(runId);
  });

  test('a behaviour report filed under the run 30 minutes ago keeps the run open', async () => {
    const gym = await newGym('behaviour');
    const runId = await liveRunStarted(gym, 4);
    await markPresent(gym, runId, 230);
    await client.query(
      `insert into pilot.behaviour_keys (organization_id, behaviour_key, label, skill_id, created_by_account_id)
       values ($1, 'drops_guard', 'Drops guard', 'SK-DEF-01', $2)`,
      [gym.organizationId, gym.coach],
    );
    await client.query(
      `insert into pilot.behaviour_observations
         (organization_id, athlete_id, behaviour_key, episode_id, session_key, task_context_key, task_constraint,
          polarity, attribution_target, attribution_certainty, source_type, source_quality, observer_account_id,
          author_role, observed_at, created_at)
       values ($1, $2, 'drops_guard', 'ep:' || gen_random_uuid()::text, 'run:' || $3, 'drill:jab', 'controlled',
               'occurrence', 'athlete', 'stated', 'manual', 'high', $4,
               'coach', now() - interval '30 minutes', now() - interval '30 minutes')`,
      [gym.organizationId, gym.athlete, runId, gym.coach],
    );
    expect((await getLiveRunForCoach(gym.organizationId, gym.coach))?.run_id).toBe(runId);
  });

  test('a run paused four hours ago closes, with the pause banked up to the close and cleared', async () => {
    const gym = await newGym('paused');
    const runId = await liveRunStarted(gym, 5);
    await client.query(
      `update pilot.session_script_runs set paused_at = started_at + interval '1 hour', paused_seconds = 0 where run_id = $1`,
      [runId],
    );
    expect(await getLiveRunForCoach(gym.organizationId, gym.coach)).toBeNull();
    const row = await runRow(runId);
    expect(row.run_state).toBe('abandoned');
    expect(row.idle_end_hours).toBe('4.0000');
    expect(row.paused_at).toBeNull();
    expect(row.paused_seconds).toBe(3 * 3600);
  });

  test('a run resumed after a long pause is not idle from its start: the banked pause is a floor on the resume', async () => {
    const gym = await newGym('resumed');
    const runId = await liveRunStarted(gym, 6);
    // Paused for four of those six hours and resumed since: the resume was at least two hours ago.
    await client.query(`update pilot.session_script_runs set paused_seconds = 4 * 3600 where run_id = $1`, [runId]);
    expect((await getLiveRunForCoach(gym.organizationId, gym.coach))?.run_id).toBe(runId);
  });

  test('a settled run is never touched, however old', async () => {
    const gym = await newGym('settled');
    const runId = await liveRunStarted(gym, 0);
    await client.query(
      `update pilot.session_script_runs
          set run_state = 'completed', started_at = now() - interval '30 hours', ended_at = now() - interval '29 hours',
              deviation_note = 'Ran long.'
        where run_id = $1`,
      [runId],
    );
    await getLiveRunForCoach(gym.organizationId, gym.coach);
    const row = await runRow(runId);
    expect(row.run_state).toBe('completed');
    expect(row.deviation_note).toBe('Ran long.');
    expect(row.idle_end_hours).toBe('1.0000');
  });

  test("one gym's read never settles another gym's run", async () => {
    const ours = await newGym('ours');
    const theirs = await newGym('theirs');
    const theirRun = await liveRunStarted(theirs, 6);
    await getLiveRunForCoach(ours.organizationId, ours.coach);
    expect((await runRow(theirRun)).run_state).toBe('in_progress');
  });

  test("another coach's forgotten run in the same gym closes on any reader's look", async () => {
    const gym = await newGym('other');
    const theirRun = await liveRunStarted(gym, 4, gym.otherCoach);
    expect(await getLiveRunForCoach(gym.organizationId, gym.coach)).toBeNull();
    expect((await runRow(theirRun)).run_state).toBe('abandoned');
  });
});

describe('the paired TV drops a forgotten session (D2)', () => {
  test('a TV showing a session reads it while live, and reads nothing once it has been idle three hours', async () => {
    const gym = await newGym('tv');
    const runId = await liveRunStarted(gym, 0);
    await setSessionScriptRunShowOnWall(gym.organizationId, gym.coach, runId, true);
    const minted = await mintGymTvPairCode(gym.organizationId, gym.coach, 'Gym main');
    const redeemed = await redeemGymTvPairCode(minted.code);
    if (!redeemed) throw new Error('test bug: pairing failed');
    await sendRunToGymTv(gym.organizationId, gym.coach, minted.tv_id, runId);

    expect((await readGymTvSession(redeemed.device_key))?.session?.run_id).toBe(runId);

    await client.query(`update pilot.session_script_runs set started_at = now() - interval '3 hours 5 minutes' where run_id = $1`, [runId]);
    expect((await readGymTvSession(redeemed.device_key))?.session).toBeNull();
    expect((await runRow(runId)).run_state).toBe('abandoned');
  });

  test('with the TV switched off, the Paired TVs list does not show a forgotten run on it, and another coach can send to it', async () => {
    const gym = await newGym('tv-off');
    const forgotten = await liveRunStarted(gym, 0, gym.otherCoach);
    await setSessionScriptRunShowOnWall(gym.organizationId, gym.otherCoach, forgotten, true);
    const minted = await mintGymTvPairCode(gym.organizationId, gym.otherCoach, 'Gym main');
    if (!(await redeemGymTvPairCode(minted.code))) throw new Error('test bug: pairing failed');
    await sendRunToGymTv(gym.organizationId, gym.otherCoach, minted.tv_id, forgotten);
    await client.query(`update pilot.session_script_runs set started_at = now() - interval '4 hours' where run_id = $1`, [forgotten]);

    // Nothing reads the TV (it is off). The list is the first reader.
    expect((await listGymTvs(gym.organizationId)).find((tv) => tv.tv_id === minted.tv_id)?.current_run_id).toBeNull();
    expect((await runRow(forgotten)).run_state).toBe('abandoned');

    // This coach's own session goes to the TV: the forgotten run no longer holds it.
    const mine = await startSessionScriptRun(gym.organizationId, gym.coach, {});
    await setSessionScriptRunShowOnWall(gym.organizationId, gym.coach, mine.run_id, true);
    const sent = await sendRunToGymTv(gym.organizationId, gym.coach, minted.tv_id, mine.run_id);
    expect(sent.current_run_id).toBe(mine.run_id);
  });

  test('a send to a TV still held by another coach\'s forgotten run settles that run first instead of refusing TV_IN_USE', async () => {
    const gym = await newGym('tv-send');
    const forgotten = await liveRunStarted(gym, 0, gym.otherCoach);
    await setSessionScriptRunShowOnWall(gym.organizationId, gym.otherCoach, forgotten, true);
    const minted = await mintGymTvPairCode(gym.organizationId, gym.otherCoach, 'Gym main');
    if (!(await redeemGymTvPairCode(minted.code))) throw new Error('test bug: pairing failed');
    await sendRunToGymTv(gym.organizationId, gym.otherCoach, minted.tv_id, forgotten);
    const mine = await startSessionScriptRun(gym.organizationId, gym.coach, {});
    await setSessionScriptRunShowOnWall(gym.organizationId, gym.coach, mine.run_id, true);
    // The forgotten run goes idle only now, after this coach's start and with no reader since.
    await client.query(`update pilot.session_script_runs set started_at = now() - interval '4 hours' where run_id = $1`, [forgotten]);

    const sent = await sendRunToGymTv(gym.organizationId, gym.coach, minted.tv_id, mine.run_id);
    expect(sent.current_run_id).toBe(mine.run_id);
    expect((await runRow(forgotten)).run_state).toBe('abandoned');
  });
});
