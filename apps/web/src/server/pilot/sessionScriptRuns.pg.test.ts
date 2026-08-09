// Real PostgreSQL-backed suite for the session run lifecycle: the columns and guards added by
// pilot_slice_postgres_session_run_state_migration.sql, and the write path in sessionScriptRuns.ts.
//
// LEADS WITH A NEGATIVE CONTROL in beforeAll: before the migration is applied, selecting run_state
// is an error. That is the state every environment is in right now, and proving it first means
// everything below tests the migration rather than something that was always true.
//
// The migration is applied THROUGH ITS OWN RUNNER, so the runner's readiness gate is exercised as
// well -- if the gate is wrong about what the migration produces, beforeAll throws.
//
// What needs proving here, none of which a unit test or a reading of the SQL can establish:
//
// 1. Each of the five check constraints actually rejects. A constraint that failed to attach looks
//    identical to one that is holding until something tries to violate it.
// 2. pilot_ssrun_one_live_per_coach really is unique per coach and NOT global -- a second coach on
//    the same floor must be able to run their own class at the same time.
// 3. Rows written before the migration keep NULL run_state. A default would silently relabel a
//    post-hoc record as a live or completed session.
// 4. The database's own pause arithmetic. resumeSessionScriptRun banks elapsed pause time using
//    now() inside SQL, so only real Postgres can prove it accumulates across repeated pauses.
// 5. The two invariants the database cannot hold: a cursor from another script is refused, and
//    another coach's run is indistinguishable from a missing one.
//
// Spins up the same disposable, local-only embedded Postgres the other migration suites use. It
// NEVER connects to production or staging.
import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import {
  SessionScriptRunError,
  finishSessionScriptRun,
  getLiveRunForCoach,
  listSettledRunsForScript,
  moveSessionScriptRunCursor,
  pauseSessionScriptRun,
  resumeSessionScriptRun,
  startSessionScriptRun,
} from './sessionScriptRuns';

jest.setTimeout(180_000);

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
  // startSessionScriptRun runs in a transaction. The embedded client IS the connection here, so
  // this hands it straight through -- the point is that the module's own BEGIN/COMMIT path is the
  // one exercised, not a substitute.
  withTransaction: jest.fn(async (fn: (c: Client) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return fn(activeClient);
  }),
}));

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-run-state-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_session_scripts_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-session-scripts-migration.mjs',
);
// The suite under test. Applied SECOND, because it alters the table the first one creates.
const RUN_STATE_MIGRATION_FILE = 'pilot_slice_postgres_session_run_state_migration.sql';
const RUN_STATE_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-session-run-state-migration.mjs',
);
let runStateMigrationSql: string;
let applyRunStateMigration: (c: Client, sql: string) => Promise<void>;

const ORG_A = 'org-ss-a';
const ORG_B = 'org-ss-b';
const COACH_A = 'acct-ss-coach-a';
const COACH_B = 'acct-ss-coach-b';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
// pilot.session_script_blocks carries an FK to pilot.drill_library, so folder
// 01's migration is a genuine prerequisite -- this mirrors the dependency
// APPLY_ORDER.md records, and the migration fails outright without it.
let prerequisiteSchemaSql: string[];
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let client: Client;

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
      if (address === null || typeof address === 'string') {
        reject(new Error('Could not determine a free port'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

// NOTE: the bootstrap above is shared with sessionScripts.pg.test.ts. Its insertScript/insertBlock
// helpers were removed here rather than left unused -- this suite seeds through seedScript below,
// which also satisfies pilot_ssb_content, and two ways to insert the same fixture is how the two
// suites would drift apart.

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

  prerequisiteSchemaSql = await Promise.all(
    ['pilot_slice_postgres.sql', 'pilot_slice_postgres_drill_library_v3_migration.sql']
      .map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');
  runStateMigrationSql = await fs.readFile(path.join(INFRA_DIR, RUN_STATE_MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    c: Client,
    sql: string,
  ) => Promise<void>;

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query('drop database if exists ppbf_test_session_run_state');
  await admin.query('create database ppbf_test_session_run_state');
  await admin.end();

  client = new Client({ connectionString: connectionStringFor('ppbf_test_session_run_state') });
  await client.connect();
  for (const sql of prerequisiteSchemaSql) {
    await client.query(sql);
  }
  await applyMigrationTransaction(client, migrationSql);

  // NEGATIVE CONTROL. Before the run-state migration the columns do not exist -- which is the
  // state every environment is in right now. Proving that first means the assertions below are
  // testing the migration rather than something that was always true.
  await expect(
    client.query('select run_state from pilot.session_script_runs'),
  ).rejects.toThrow(/run_state/);

  const runStateRunner = await nativeDynamicImport(pathToFileURL(RUN_STATE_RUNNER_PATH).href);
  applyRunStateMigration = runStateRunner.applyMigrationTransaction as (
    c: Client,
    sql: string,
  ) => Promise<void>;
  // Applied through its own runner, so the runner's readiness gate is exercised too: if the gate
  // is wrong about what the migration produces, this throws.
  await applyRunStateMigration(client, runStateMigrationSql);

  for (const [org, coach] of [[ORG_A, COACH_A], [ORG_B, COACH_B]]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1,$1,'active') on conflict do nothing`,
      [org],
    );
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1,'coach',$2,'microsoft') on conflict do nothing`,
      [coach, org],
    );
  }

  activeClient = client;
});

afterAll(async () => {
  activeClient = null;
  if (client) await client.end();

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(safetyTimer);
      resolve();
    };
    const safetyTimer = setTimeout(finish, 10_000);
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  // Runs first: current_block_id and script_id are foreign keys into the two below.
  await client.query('delete from pilot.session_script_runs');
  await client.query('delete from pilot.session_script_blocks');
  await client.query('delete from pilot.session_scripts');
});


// ---------------------------------------------------------------------------
// Fixtures. Blocks must satisfy pilot_ssb_content -- a block either teaches
// something or moves the room -- so these carry what_to_say rather than being
// empty, which is the authoring error that constraint exists to catch.
async function seedScript(
  org: string,
  coach: string,
  scriptId: string,
  blockIds: string[],
  version = 1,
): Promise<void> {
  await client.query(
    `insert into pilot.session_scripts
       (organization_id, script_id, lineage_id, version, name, created_by_account_id)
     values ($1,$2,$2,$3,$2,$4)`,
    [org, scriptId, version, coach],
  );
  for (let i = 0; i < blockIds.length; i += 1) {
    await client.query(
      `insert into pilot.session_script_blocks
         (organization_id, block_id, script_id, block_order,
          start_offset_min, end_offset_min, block_label, what_to_say)
       values ($1,$2,$3,$4,$5,$6,$7,'cue')`,
      [org, blockIds[i], scriptId, i + 1, i * 10, (i + 1) * 10, `block ${i + 1}`],
    );
  }
}

async function readRun(runId: string) {
  const result = await client.query(
    `select run_state, started_at, ended_at, current_block_id, paused_at, paused_seconds,
            script_version, blocks_completed
       from pilot.session_script_runs where run_id = $1`,
    [runId],
  );
  return result.rows[0];
}

// A row inserted the way one would have been written before this migration existed: no run_state,
// no started_at. Used to prove nothing backfills or relabels it.
async function seedLegacyRun(org: string, coach: string, scriptId: string, runId: string) {
  await client.query(
    `insert into pilot.session_script_runs
       (organization_id, run_id, script_id, script_version, delivered_by_account_id,
        delivered_on, blocks_completed)
     values ($1,$2,$3,1,$4,current_date - 30,7)`,
    [org, runId, scriptId, coach],
  );
}

describe('the migration leaves pre-existing rows alone', () => {
  it('keeps run_state NULL on a row written without one, and does not invent a start time', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-legacy', ['blk-l1']);
    await seedLegacyRun(ORG_A, COACH_A, 'scr-legacy', 'run-legacy');

    const row = await readRun('run-legacy');
    // Null, not 'completed' and not 'in_progress'. See the migration header: either default would
    // be a claim about a session nobody timed.
    expect(row.run_state).toBeNull();
    expect(row.started_at).toBeNull();
    expect(row.paused_seconds).toBeNull();
    // The pre-existing data is untouched.
    expect(row.blocks_completed).toBe(7);
  });

  it('does not treat a legacy row as a live run, so it cannot block a coach starting one', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-legacy2', ['blk-l2']);
    await seedLegacyRun(ORG_A, COACH_A, 'scr-legacy2', 'run-legacy2');

    expect(await getLiveRunForCoach(ORG_A, COACH_A)).toBeNull();
    // And the partial unique index must not count it, or this coach could never start again.
    const started = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-legacy2' });
    expect(started.run_state).toBe('in_progress');
  });
});

describe('the five check constraints actually reject', () => {
  beforeEach(async () => {
    await seedScript(ORG_A, COACH_A, 'scr-c', ['blk-c1', 'blk-c2']);
  });

  async function insertRaw(cols: string, vals: string, params: unknown[]) {
    return client.query(
      `insert into pilot.session_script_runs
         (organization_id, run_id, script_id, script_version, delivered_by_account_id,
          delivered_on, ${cols})
       values ($1,$2,'scr-c',1,$3,current_date, ${vals})`,
      params,
    );
  }

  // An unknown state is refused by BOTH pilot_ssrun_state_vocab and pilot_ssrun_state_times, since
  // state_times enumerates the valid states in its own branches. Postgres reports whichever it
  // evaluates first, so this asserts either name rather than pinning one and going red on an
  // implementation detail of constraint ordering. The overlap is worth keeping: the vocabulary
  // still cannot be bypassed if one of the two were ever dropped.
  it('rejects a run_state outside the vocabulary', async () => {
    await expect(
      insertRaw('run_state, started_at', `'paused', now()`, [ORG_A, 'run-v1', COACH_A]),
    ).rejects.toThrow(/pilot_ssrun_state_vocab|pilot_ssrun_state_times/);
  });

  it('rejects an in_progress run with no start time', async () => {
    await expect(
      insertRaw('run_state', `'in_progress'`, [ORG_A, 'run-v2', COACH_A]),
    ).rejects.toThrow(/pilot_ssrun_state_times/);
  });

  it('rejects an in_progress run that has already ended', async () => {
    await expect(
      insertRaw('run_state, started_at, ended_at', `'in_progress', now(), now()`, [
        ORG_A, 'run-v3', COACH_A,
      ]),
    ).rejects.toThrow(/pilot_ssrun_state_times/);
  });

  it('rejects a completed run with no end time', async () => {
    await expect(
      insertRaw('run_state, started_at', `'completed', now()`, [ORG_A, 'run-v4', COACH_A]),
    ).rejects.toThrow(/pilot_ssrun_state_times/);
  });

  it('rejects an end time before the start time', async () => {
    await expect(
      insertRaw(
        'run_state, started_at, ended_at',
        `'completed', now(), now() - interval '1 hour'`,
        [ORG_A, 'run-v5', COACH_A],
      ),
    ).rejects.toThrow(/pilot_ssrun_end_after_start/);
  });

  // A settled run that claims to be paused is the shape a stuck timer takes.
  it('rejects a paused run that is not live', async () => {
    await expect(
      insertRaw(
        'run_state, started_at, ended_at, paused_at',
        `'completed', now(), now(), now()`,
        [ORG_A, 'run-v6', COACH_A],
      ),
    ).rejects.toThrow(/pilot_ssrun_pause_only_live/);
  });

  it('rejects negative banked pause time', async () => {
    await expect(
      insertRaw('run_state, started_at, paused_seconds', `'in_progress', now(), -1`, [
        ORG_A, 'run-v7', COACH_A,
      ]),
    ).rejects.toThrow(/pilot_ssrun_paused_seconds_sane/);
  });

  it('rejects a cursor pointing at a block that does not exist', async () => {
    await expect(
      insertRaw('run_state, started_at, current_block_id', `'in_progress', now(), 'blk-nope'`, [
        ORG_A, 'run-v8', COACH_A,
      ]),
    ).rejects.toThrow(/pilot_ssrun_current_block_fk/);
  });
});

describe('one live run per coach', () => {
  it('refuses a second live run for the same coach', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-1', ['blk-1a']);
    await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-1' });

    await expect(startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-1' })).rejects.toThrow(
      'SESSION_RUN_ALREADY_LIVE',
    );
  });

  // The index must be per coach, not per organization. Two coaches run two classes on the same
  // floor at the same time; a global constraint would stop the second one dead.
  it('allows a different coach in the same organization to run their own class simultaneously', async () => {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ('acct-ss-coach-a2','coach',$1,'microsoft') on conflict do nothing`,
      [ORG_A],
    );
    await seedScript(ORG_A, COACH_A, 'scr-2', ['blk-2a']);

    const first = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-2' });
    const second = await startSessionScriptRun(ORG_A, 'acct-ss-coach-a2', { scriptId: 'scr-2' });

    expect(first.run_state).toBe('in_progress');
    expect(second.run_state).toBe('in_progress');
    expect(second.run_id).not.toBe(first.run_id);
  });

  it('frees the coach to start again once the run is finished', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-3', ['blk-3a']);
    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-3' });
    await finishSessionScriptRun(ORG_A, COACH_A, live.run_id, { runState: 'completed' });

    const next = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-3' });
    expect(next.run_id).not.toBe(live.run_id);
  });
});

describe('starting a run', () => {
  it('opens the cursor on the first block in running order, not the first inserted', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-order', ['blk-o1', 'blk-o2', 'blk-o3']);
    // Make the LAST-inserted block the first in running order. Pushing the other two up rather
    // than setting this one to 0, because block_order carries its own `> 0` check.
    await client.query(
      `update pilot.session_script_blocks set block_order = block_order + 10
        where block_id in ('blk-o1','blk-o2')`,
    );

    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-order' });
    expect(live.current_block_id).toBe('blk-o3');
  });

  it('pins the script version so a later edit cannot rewrite what was delivered', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-ver', ['blk-ver1'], 4);
    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-ver' });
    expect(live.script_version).toBe(4);

    await client.query(`update pilot.session_scripts set version = 9 where script_id = 'scr-ver'`);
    expect((await readRun(live.run_id)).script_version).toBe(4);
  });

  // This is the state the pilot_ssb_content seed blocker leaves scripts in, so it must fail with a
  // reason rather than opening a live run whose cursor is null.
  it('refuses a script with no blocks, by name', async () => {
    await client.query(
      `insert into pilot.session_scripts
         (organization_id, script_id, lineage_id, version, name, created_by_account_id)
       values ($1,'scr-empty','scr-empty',1,'empty',$2)`,
      [ORG_A, COACH_A],
    );
    await expect(
      startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-empty' }),
    ).rejects.toThrow('SESSION_SCRIPT_HAS_NO_BLOCKS');
    // And leaves nothing behind.
    const count = await client.query('select count(*)::int as n from pilot.session_script_runs');
    expect(count.rows[0].n).toBe(0);
  });

  it('refuses a script from another organization even when the id is known', async () => {
    await seedScript(ORG_B, COACH_B, 'scr-b', ['blk-b1']);
    await expect(startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-b' })).rejects.toThrow(
      'SESSION_SCRIPT_NOT_FOUND',
    );
  });
});

describe('the two invariants the database cannot hold', () => {
  it('refuses a cursor belonging to a different script in the same organization', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-tue', ['blk-tue1']);
    await seedScript(ORG_A, COACH_A, 'scr-wed', ['blk-wed1']);
    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-wed' });

    // blk-tue1 exists and satisfies the FK, which is exactly why the FK is not enough.
    await expect(
      moveSessionScriptRunCursor(ORG_A, COACH_A, live.run_id, 'blk-tue1'),
    ).rejects.toThrow('SESSION_RUN_BLOCK_NOT_IN_SCRIPT');
    expect((await readRun(live.run_id)).current_block_id).toBe('blk-wed1');
  });

  it("reports another coach's run as not found rather than as forbidden", async () => {
    await seedScript(ORG_A, COACH_A, 'scr-own', ['blk-own1', 'blk-own2']);
    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-own' });

    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ('acct-ss-coach-a3','coach',$1,'microsoft') on conflict do nothing`,
      [ORG_A],
    );
    // Same code and status as a run that does not exist, so the id cannot be probed.
    const attempt = moveSessionScriptRunCursor(ORG_A, 'acct-ss-coach-a3', live.run_id, 'blk-own2');
    await expect(attempt).rejects.toThrow('SESSION_RUN_NOT_FOUND');
    await expect(attempt.catch((e) => (e as SessionScriptRunError).status)).resolves.toBe(404);
  });
});

describe("the database's own pause arithmetic", () => {
  it('banks elapsed pause time on resume and accumulates it across repeated pauses', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-pause', ['blk-p1']);
    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-pause' });

    // Backdate the pause so there is real elapsed time to bank, rather than sleeping in a test.
    await pauseSessionScriptRun(ORG_A, COACH_A, live.run_id);
    await client.query(
      `update pilot.session_script_runs set paused_at = now() - interval '90 seconds'
        where run_id = $1`,
      [live.run_id],
    );
    const afterFirst = await resumeSessionScriptRun(ORG_A, COACH_A, live.run_id);
    expect(afterFirst.paused_at).toBeNull();
    expect(afterFirst.paused_seconds).toBeGreaterThanOrEqual(90);
    expect(afterFirst.paused_seconds).toBeLessThan(95);

    // A second pause must ADD to the banked total, not replace it.
    await pauseSessionScriptRun(ORG_A, COACH_A, live.run_id);
    await client.query(
      `update pilot.session_script_runs set paused_at = now() - interval '30 seconds'
        where run_id = $1`,
      [live.run_id],
    );
    const afterSecond = await resumeSessionScriptRun(ORG_A, COACH_A, live.run_id);
    expect(afterSecond.paused_seconds).toBeGreaterThanOrEqual(120);
    expect(afterSecond.paused_seconds).toBeLessThan(126);
  });

  it('is idempotent: pausing twice does not restart the pause and lose banked time', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-idem', ['blk-i1']);
    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-idem' });

    const first = await pauseSessionScriptRun(ORG_A, COACH_A, live.run_id);
    await client.query(
      `update pilot.session_script_runs set paused_at = now() - interval '60 seconds'
        where run_id = $1`,
      [live.run_id],
    );
    const second = await pauseSessionScriptRun(ORG_A, COACH_A, live.run_id);

    expect(first.is_paused).toBe(true);
    expect(second.is_paused).toBe(true);
    // The backdated pause survived the second call, so resuming still banks the full 60s.
    const resumed = await resumeSessionScriptRun(ORG_A, COACH_A, live.run_id);
    expect(resumed.paused_seconds).toBeGreaterThanOrEqual(60);
  });

  it('resuming a run that is not paused is a no-op rather than an error', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-nores', ['blk-n1']);
    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-nores' });
    const resumed = await resumeSessionScriptRun(ORG_A, COACH_A, live.run_id);
    expect(resumed.is_paused).toBe(false);
    expect(resumed.paused_seconds).toBe(0);
  });
});

describe('finishing settles the row', () => {
  it('clears the cursor and the pause, and records the outcome', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-fin', ['blk-f1', 'blk-f2']);
    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-fin' });
    await pauseSessionScriptRun(ORG_A, COACH_A, live.run_id);

    const settled = await finishSessionScriptRun(ORG_A, COACH_A, live.run_id, {
      runState: 'completed',
      blocksCompleted: 2,
      whatWorked: 'slip drill landed',
    });

    expect(settled.run_state).toBe('completed');
    expect(settled.ended_at).not.toBeNull();
    // Both cleared: neither is meaningful once the room has emptied, and a paused settled run
    // would violate pilot_ssrun_pause_only_live.
    expect(settled.current_block_id).toBeNull();
    expect(settled.paused_at).toBeNull();
    expect(settled.blocks_completed).toBe(2);
    expect(settled.what_worked).toBe('slip drill landed');
  });

  // Found in review, not by the original suite: the first version of finishSessionScriptRun cleared
  // paused_at without banking the open interval, so ending a session that was still paused lost that
  // pause and made every later reading of actual teaching time overcount by its length. The original
  // test paused and finished but only asserted paused_at was null, which this defect satisfies.
  it('banks an OPEN pause into paused_seconds instead of discarding it', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-finpause', ['blk-fp1']);
    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-finpause' });

    await pauseSessionScriptRun(ORG_A, COACH_A, live.run_id);
    // Backdate the pause so there is a real interval to lose.
    await client.query(
      `update pilot.session_script_runs set paused_at = now() - interval '45 seconds'
        where run_id = $1`,
      [live.run_id],
    );

    const settled = await finishSessionScriptRun(ORG_A, COACH_A, live.run_id, {
      runState: 'completed',
    });

    expect(settled.paused_at).toBeNull();
    expect(settled.paused_seconds).toBeGreaterThanOrEqual(45);
    expect(settled.paused_seconds).toBeLessThan(50);
  });

  it('leaves paused_seconds alone when the run was not paused at the end', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-finnopause', ['blk-fn1']);
    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-finnopause' });
    const settled = await finishSessionScriptRun(ORG_A, COACH_A, live.run_id, {
      runState: 'completed',
    });
    // 0, not null: this run genuinely never paused, which is a different fact from unknown.
    expect(settled.paused_seconds).toBe(0);
  });

  it('records an abandoned session as abandoned rather than as a delivery', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-ab', ['blk-ab1']);
    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-ab' });
    const settled = await finishSessionScriptRun(ORG_A, COACH_A, live.run_id, {
      runState: 'abandoned',
      deviationNote: 'room cleared after an injury',
    });
    expect(settled.run_state).toBe('abandoned');
    expect(settled.deviation_note).toBe('room cleared after an injury');
  });

  it('refuses to reopen or re-finish a settled run', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-imm', ['blk-im1', 'blk-im2']);
    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-imm' });
    await finishSessionScriptRun(ORG_A, COACH_A, live.run_id, { runState: 'completed' });

    await expect(
      finishSessionScriptRun(ORG_A, COACH_A, live.run_id, { runState: 'abandoned' }),
    ).rejects.toThrow('SESSION_RUN_NOT_LIVE');
    await expect(
      moveSessionScriptRunCursor(ORG_A, COACH_A, live.run_id, 'blk-im2'),
    ).rejects.toThrow('SESSION_RUN_NOT_LIVE');
    await expect(pauseSessionScriptRun(ORG_A, COACH_A, live.run_id)).rejects.toThrow(
      'SESSION_RUN_NOT_LIVE',
    );
  });
});

describe('history', () => {
  it('excludes a run still on the floor, and includes legacy NULL-state rows', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-hist', ['blk-h1']);
    await seedLegacyRun(ORG_A, COACH_A, 'scr-hist', 'run-h-legacy');

    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-hist' });
    let settledIds = (await listSettledRunsForScript(ORG_A, 'scr-hist')).map((r) => r.run_id);
    // A session still being taught is not yet a record of what happened.
    expect(settledIds).not.toContain(live.run_id);
    expect(settledIds).toContain('run-h-legacy');

    await finishSessionScriptRun(ORG_A, COACH_A, live.run_id, { runState: 'completed' });
    settledIds = (await listSettledRunsForScript(ORG_A, 'scr-hist')).map((r) => r.run_id);
    expect(settledIds).toContain(live.run_id);
  });
});

describe('resume', () => {
  it('returns the live run with a clock the caller did not compute', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-res', ['blk-r1']);
    const live = await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-res' });
    await client.query(
      `update pilot.session_script_runs set started_at = now() - interval '12 minutes'
        where run_id = $1`,
      [live.run_id],
    );

    const resumed = await getLiveRunForCoach(ORG_A, COACH_A);
    expect(resumed?.run_id).toBe(live.run_id);
    expect(resumed?.elapsed_seconds).toBeGreaterThanOrEqual(12 * 60);
    expect(resumed?.elapsed_seconds).toBeLessThan(13 * 60);
    expect(resumed?.is_paused).toBe(false);
  });

  it('is organization-scoped', async () => {
    await seedScript(ORG_A, COACH_A, 'scr-scope', ['blk-s1']);
    await startSessionScriptRun(ORG_A, COACH_A, { scriptId: 'scr-scope' });
    expect(await getLiveRunForCoach(ORG_B, COACH_A)).toBeNull();
  });
});
