// Real-PostgreSQL proof for the round-timer table (WO-N1-03, issue #1460):
// pilot.round_timers and its migration and runner. No module reads or writes
// the table yet; that is the next pull request.
//
// What only a real database can prove:
//
//   * THE MIGRATION LANDS in its place in the full schema, and the runner
//     applies it again as a no-op with its readiness check green.
//   * THE DATABASE REFUSES a row the clock could not mean: numbers out of
//     range, an unknown state, or a state whose times disagree with it
//     (running with no start, paused with no pause instant, ended while
//     paused, ending before starting).
//   * ONE TIMER PER RUN, tied to a run of the SAME gym, and it leaves with
//     its run.
//   * READINESS IS RED when any one guard it names (seven checks, the run
//     foreign key) is missing or looser.
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
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const RUNNER_PATH = path.resolve(__dirname, '../../../scripts/pilot-apply-round-timers-migration.mjs');

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-round-timers-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_PATH = path.join(INFRA_DIR, 'pilot_slice_postgres_round_timers_migration.sql');
const DATABASE_NAME = 'ppbf_test_n1_03_round_timers';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let applyFullSchema: (client: Client, opts?: { infraDir?: string }) => Promise<unknown>;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let migrationSql: string;
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

interface Run {
  organizationId: string;
  runId: string;
  coachId: string;
}

/** A fresh gym with a coach, a script and one run of it. */
async function newRun(label: string): Promise<Run> {
  gymCount += 1;
  const organizationId = `org-n1-03-${label}-${gymCount}`;
  const coachId = `coach@${organizationId}`;
  const runId = `run-${label}-${gymCount}`;
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [organizationId],
  );
  await client.query(
    `insert into pilot.disciplines (organization_id, discipline, display_name, lane, exposure_model)
     values ($1, 'boxing', 'Boxing', 'striking', 'head_impact')`,
    [organizationId],
  );
  await client.query(`insert into pilot.accounts (account_id, role, organization_id) values ($1, 'coach', $2)`, [
    coachId,
    organizationId,
  ]);
  await client.query(
    `insert into pilot.session_scripts (organization_id, script_id, lineage_id, version, name, total_minutes, created_by_account_id)
     values ($1, $2, $2, 1, 'Round night', 60, $3)`,
    [organizationId, `scr-${runId}`, coachId],
  );
  await client.query(
    `insert into pilot.session_script_runs (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on)
     values ($1, $2, $3, 1, $4, current_date)`,
    [organizationId, runId, `scr-${runId}`, coachId],
  );
  return { organizationId, runId, coachId };
}

interface TimerRow {
  round_seconds?: number;
  rest_seconds?: number;
  rounds_total?: number;
  state?: string;
  started_at?: string | null;
  paused_at?: string | null;
  paused_seconds?: number;
  ended_at?: string | null;
}

async function insertTimer(run: Run, row: TimerRow = {}, runId = run.runId): Promise<void> {
  await client.query(
    `insert into pilot.round_timers
       (organization_id, run_id, round_seconds, rest_seconds, rounds_total, state,
        started_at, paused_at, paused_seconds, ended_at, configured_by_account_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      run.organizationId,
      runId,
      row.round_seconds ?? 180,
      row.rest_seconds ?? 60,
      row.rounds_total ?? 3,
      row.state ?? 'ready',
      row.started_at ?? null,
      row.paused_at ?? null,
      row.paused_seconds ?? 0,
      row.ended_at ?? null,
      run.coachId,
    ],
  );
}

/** Runs `fn` in a savepoint and reports the constraint that refused it, or null. */
async function refusedBy(fn: () => Promise<unknown>): Promise<string | null> {
  await client.query('BEGIN');
  try {
    await fn();
    return null;
  } catch (error) {
    return (error as { constraint?: string }).constraint ?? (error as Error).message;
  } finally {
    await client.query('ROLLBACK');
  }
}

const STARTED = '2026-10-12T18:00:00Z';
const LATER = '2026-10-12T18:05:00Z';

describe('the round-timer migration', () => {
  test('lands in the full schema, and the runner applies it again with readiness green', async () => {
    const exists = await client.query(`select to_regclass('pilot.round_timers') is not null as ready`);
    expect(exists.rows[0].ready).toBe(true);
    await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
    await expect(applyMigrationTransaction(client, migrationSql)).resolves.toBeUndefined();
  });

  test('a timer is written ready, with no start, and nothing starts it', async () => {
    const run = await newRun('ready');
    await insertTimer(run);
    const row = await client.query(
      `select state, started_at, paused_at, ended_at, paused_seconds, created_at is not null as stamped
         from pilot.round_timers where organization_id = $1 and run_id = $2`,
      [run.organizationId, run.runId],
    );
    expect(row.rows).toEqual([
      { state: 'ready', started_at: null, paused_at: null, ended_at: null, paused_seconds: 0, stamped: true },
    ]);
  });

  test('each state with its own times is accepted', async () => {
    for (const row of [
      { state: 'running', started_at: STARTED },
      { state: 'paused', started_at: STARTED, paused_at: LATER, paused_seconds: 20 },
      { state: 'ended', started_at: STARTED, ended_at: LATER },
      { state: 'ended', ended_at: LATER },
      { round_seconds: 1, rest_seconds: 0, rounds_total: 1 },
      { round_seconds: 3600, rest_seconds: 3600, rounds_total: 100 },
    ]) {
      const run = await newRun('ok');
      await expect(insertTimer(run, row)).resolves.toBeUndefined();
    }
  });

  test.each([
    ['a round of no length', { round_seconds: 0 }, 'pilot_round_timers_round_seconds_check'],
    ['a round over an hour', { round_seconds: 3601 }, 'pilot_round_timers_round_seconds_check'],
    ['negative rest', { rest_seconds: -1 }, 'pilot_round_timers_rest_seconds_check'],
    ['rest over an hour', { rest_seconds: 3601 }, 'pilot_round_timers_rest_seconds_check'],
    ['no rounds', { rounds_total: 0 }, 'pilot_round_timers_rounds_total_check'],
    ['over a hundred rounds', { rounds_total: 101 }, 'pilot_round_timers_rounds_total_check'],
    ['an unknown state', { state: 'counting' }, 'pilot_round_timers_state_check'],
    ['negative paused time', { paused_seconds: -1 }, 'pilot_round_timers_paused_seconds_check'],
    ['ready with a start', { state: 'ready', started_at: STARTED }, 'pilot_round_timers_state_times_check'],
    ['running with no start', { state: 'running' }, 'pilot_round_timers_state_times_check'],
    ['running and paused', { state: 'running', started_at: STARTED, paused_at: LATER }, 'pilot_round_timers_state_times_check'],
    ['paused with no pause instant', { state: 'paused', started_at: STARTED }, 'pilot_round_timers_state_times_check'],
    ['ended while paused', { state: 'ended', started_at: STARTED, paused_at: LATER, ended_at: LATER }, 'pilot_round_timers_state_times_check'],
    ['ended with no end', { state: 'ended', started_at: STARTED }, 'pilot_round_timers_state_times_check'],
    ['running with an end', { state: 'running', started_at: STARTED, ended_at: LATER }, 'pilot_round_timers_state_times_check'],
    ['ending before it started', { state: 'ended', started_at: LATER, ended_at: STARTED }, 'pilot_round_timers_end_after_start_check'],
  ] as const)('refuses %s', async (_name, row, constraint) => {
    const run = await newRun('bad');
    expect(await refusedBy(() => insertTimer(run, row))).toBe(constraint);
  });

  test('one timer per run', async () => {
    const run = await newRun('one');
    await insertTimer(run);
    expect(await refusedBy(() => insertTimer(run))).toBe('pilot_round_timers_pkey');
  });

  test("a timer cannot point at another gym's run", async () => {
    const mine = await newRun('mine');
    const theirs = await newRun('theirs');
    expect(await refusedBy(() => insertTimer(mine, {}, theirs.runId))).toBe('pilot_round_timers_run_fk');
  });

  test('the timer leaves with its run, and only with it', async () => {
    const run = await newRun('cascade');
    const other = await newRun('stays');
    await insertTimer(run);
    await insertTimer(other);
    await client.query(`delete from pilot.session_script_runs where organization_id = $1 and run_id = $2`, [
      run.organizationId,
      run.runId,
    ]);
    const left = await client.query(`select organization_id from pilot.round_timers where organization_id in ($1, $2)`, [
      run.organizationId,
      other.organizationId,
    ]);
    expect(left.rows).toEqual([{ organization_id: other.organizationId }]);
  });
});

describe('the runner refuses a database where a guard is missing or looser', () => {
  test.each([
    ['the round length check dropped', 'alter table pilot.round_timers drop constraint pilot_round_timers_round_seconds_check'],
    ['the rest check dropped', 'alter table pilot.round_timers drop constraint pilot_round_timers_rest_seconds_check'],
    ['the round count check dropped', 'alter table pilot.round_timers drop constraint pilot_round_timers_rounds_total_check'],
    ['the state check dropped', 'alter table pilot.round_timers drop constraint pilot_round_timers_state_check'],
    ['the paused time check dropped', 'alter table pilot.round_timers drop constraint pilot_round_timers_paused_seconds_check'],
    ['the state and times check dropped', 'alter table pilot.round_timers drop constraint pilot_round_timers_state_times_check'],
    ['the end after start check dropped', 'alter table pilot.round_timers drop constraint pilot_round_timers_end_after_start_check'],
    [
      'the state check loosened',
      `alter table pilot.round_timers drop constraint pilot_round_timers_state_check,
         add constraint pilot_round_timers_state_check check (state in ('ready', 'running', 'paused', 'ended', 'stuck'))`,
    ],
    [
      'the state and times check loosened',
      `alter table pilot.round_timers drop constraint pilot_round_timers_state_times_check,
         add constraint pilot_round_timers_state_times_check check (state is not null)`,
    ],
    ['the run foreign key dropped', 'alter table pilot.round_timers drop constraint pilot_round_timers_run_fk'],
    [
      'the run foreign key no longer cascading',
      `alter table pilot.round_timers drop constraint pilot_round_timers_run_fk,
         add constraint pilot_round_timers_run_fk foreign key (organization_id, run_id)
           references pilot.session_script_runs(organization_id, run_id)`,
    ],
  ])('%s', async (_name, change) => {
    // The change runs inside a transaction the runner joins: its BEGIN is a
    // no-op there, and its ROLLBACK on refusal undoes the change too, so no
    // case leaks into the next. (A wrongly green readiness would COMMIT it,
    // and the cases after would show that as well.)
    await client.query('BEGIN');
    await client.query(change);
    await expect(applyMigrationTransaction(client, migrationSql)).rejects.toThrow('ROUND_TIMERS_NOT_READY');
    const tx = await client.query('select pg_current_xact_id_if_assigned() is null as idle');
    expect(tx.rows[0].idle).toBe(true);
  });
});

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
  const runner = await nativeDynamicImport(pathToFileURL(RUNNER_PATH).href);
  applyMigrationTransaction = runner.applyMigrationTransaction as typeof applyMigrationTransaction;
  migrationSql = await fs.readFile(MIGRATION_PATH, 'utf8');

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${DATABASE_NAME}`);
  await admin.query(`create database ${DATABASE_NAME}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(DATABASE_NAME) });
  await client.connect();
  // The whole schema production runs (scripts/lib/full-schema.mjs), which
  // applies this migration in its place in apply-migrations.yml's `all` list.
  await applyFullSchema(client, { infraDir: INFRA_DIR });
});

afterAll(async () => {
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
  // On Windows kill() terminates the server script outright, so its own
  // cleanup never runs and Postgres may still hold files here for a moment.
  await fs.rm(DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(() => {});
});

