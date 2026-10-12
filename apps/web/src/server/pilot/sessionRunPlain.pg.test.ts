// Real PostgreSQL contract test for pilot_slice_postgres_session_run_plain_migration.sql
// (issue #1523, N8-01 PR 1: a coach can start a plain session with no script).
//
// What needs a real database to prove: that a run with no script cannot be stored before the
// migration and can after it; that the checks around it hold (both script columns or neither, no
// cursor and a tracked state for a plain run, a live scripted run still needs its cursor, the
// script foreign key still binds a scripted run, one live run per coach still holds); that
// re-running the older run-state migration after a live plain run exists does not fail (the `all`
// chain does exactly that); and that the runner's own readiness assertion refuses a half-applied
// result. Spins up the disposable local embedded Postgres the other migration suites use. It never
// connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-run-plain-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const SCRIPTS_DIR = path.resolve(__dirname, '../../../scripts');

const ORG = 'org-plain';
const COACH = 'acct-plain-coach';
const OTHER_COACH = 'acct-plain-coach-2';

type Apply = (client: Client, sql: string) => Promise<void>;

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
let plainSql: string;
let runStateSql: string;
let applyPlain: Apply;
let applyRunState: Apply;

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

async function runner(file: string): Promise<Apply> {
  const loaded = await nativeDynamicImport(pathToFileURL(path.join(SCRIPTS_DIR, file)).href);
  return loaded.applyMigrationTransaction as Apply;
}

function insertRun(values: {
  runId: string;
  scriptId?: string | null;
  scriptVersion?: number | null;
  coach?: string;
  runState?: string | null;
  blockId?: string | null;
}) {
  return client.query(
    `insert into pilot.session_script_runs
       (organization_id, run_id, script_id, script_version, delivered_by_account_id,
        delivered_on, run_state, started_at, current_block_id, paused_seconds)
     values ($1, $2, $3, $4, $5, current_date, $6,
             case when $6::text is null then null else now() end, $7,
             case when $6::text is null then null else 0 end)`,
    [
      ORG,
      values.runId,
      values.scriptId === undefined ? null : values.scriptId,
      values.scriptVersion === undefined ? null : values.scriptVersion,
      values.coach ?? COACH,
      values.runState === undefined ? 'in_progress' : values.runState,
      values.blockId === undefined ? null : values.blockId,
    ],
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

  const read = (file: string) => fs.readFile(path.join(INFRA_DIR, file), 'utf8');
  const [baseSql, drillsSql, scriptsSql, wallSql] = await Promise.all([
    read('pilot_slice_postgres.sql'),
    read('pilot_slice_postgres_drill_library_v3_migration.sql'),
    read('pilot_slice_postgres_session_scripts_migration.sql'),
    read('pilot_slice_postgres_session_run_show_on_wall_migration.sql'),
  ]);
  runStateSql = await read('pilot_slice_postgres_session_run_state_migration.sql');
  plainSql = await read('pilot_slice_postgres_session_run_plain_migration.sql');
  applyPlain = await runner('pilot-apply-session-run-plain-migration.mjs');
  applyRunState = await runner('pilot-apply-session-run-state-migration.mjs');

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query('drop database if exists ppbf_test_session_run_plain');
  await admin.query('create database ppbf_test_session_run_plain');
  await admin.end();

  client = new Client({ connectionString: connectionStringFor('ppbf_test_session_run_plain') });
  await client.connect();
  await client.query(baseSql);
  await client.query(drillsSql);
  await (await runner('pilot-apply-session-scripts-migration.mjs'))(client, scriptsSql);
  await applyRunState(client, runStateSql);
  await (await runner('pilot-apply-session-run-show-on-wall-migration.mjs'))(client, wallSql);

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG],
  );
  for (const coach of [COACH, OTHER_COACH]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'coach', $2, 'microsoft')`,
      [coach, ORG],
    );
  }
  await client.query(
    `insert into pilot.session_scripts (organization_id, script_id, lineage_id, version, name, created_by_account_id)
     values ($1, 'scr-1', 'scr-1', 1, 'Round work', $2)`,
    [ORG, COACH],
  );
  await client.query(
    `insert into pilot.session_script_blocks
       (organization_id, block_id, script_id, block_order, start_offset_min, end_offset_min, block_label, what_to_say)
     values ($1, 'blk-1', 'scr-1', 1, 0, 10, 'warm-up', 'cue')`,
    [ORG],
  );
  // Rows from before the migration, one of each shape production can hold: a live scripted run,
  // a settled scripted run, and a pre-tracking legacy row (run_state NULL). Each must come through
  // the new checks untouched (review 1 #4).
  await insertRun({ runId: 'run-before', scriptId: 'scr-1', scriptVersion: 1, coach: OTHER_COACH, blockId: 'blk-1' });
  await client.query(
    `insert into pilot.session_script_runs
       (organization_id, run_id, script_id, script_version, delivered_by_account_id,
        delivered_on, run_state, started_at, ended_at, current_block_id, paused_seconds)
     values ($1, 'run-before-settled', 'scr-1', 1, $2, current_date - 1, 'completed',
             now() - interval '1 day', now() - interval '1 day' + interval '1 hour', null, 0)`,
    [ORG, COACH],
  );
  await client.query(
    `insert into pilot.session_script_runs
       (organization_id, run_id, script_id, script_version, delivered_by_account_id, delivered_on)
     values ($1, 'run-before-legacy', 'scr-1', 1, $2, current_date - 30)`,
    [ORG, COACH],
  );
});

afterAll(async () => {
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

describe('session run plain migration against real Postgres', () => {
  test('before it, a run with no script cannot be stored', async () => {
    await expect(insertRun({ runId: 'run-plain-early' })).rejects.toThrow(/null value in column "script_id"/);
  });

  test('the runner applies it, a re-apply is a no-op, and the earlier scripted run is untouched', async () => {
    await applyPlain(client, plainSql);
    await applyPlain(client, plainSql);

    const columns = await client.query(
      `select column_name, is_nullable from information_schema.columns
       where table_schema = 'pilot' and table_name = 'session_script_runs' and column_name in ('script_id', 'script_version')
       order by column_name`,
    );
    expect(columns.rows).toEqual([
      { column_name: 'script_id', is_nullable: 'YES' },
      { column_name: 'script_version', is_nullable: 'YES' },
    ]);
    const before = await client.query(
      `select run_id, script_id, script_version, run_state, current_block_id from pilot.session_script_runs
       where run_id like 'run-before%' order by run_id`,
    );
    expect(before.rows).toEqual([
      { run_id: 'run-before', script_id: 'scr-1', script_version: 1, run_state: 'in_progress', current_block_id: 'blk-1' },
      { run_id: 'run-before-legacy', script_id: 'scr-1', script_version: 1, run_state: null, current_block_id: null },
      { run_id: 'run-before-settled', script_id: 'scr-1', script_version: 1, run_state: 'completed', current_block_id: null },
    ]);
  });

  test('a live plain session is stored: no script, no version, no cursor', async () => {
    await insertRun({ runId: 'run-plain' });
    const row = await client.query(`select script_id, script_version, run_state, current_block_id from pilot.session_script_runs where run_id = 'run-plain'`);
    expect(row.rows).toEqual([{ script_id: null, script_version: null, run_state: 'in_progress', current_block_id: null }]);

    // It can be paused, put on the TV, and finished like any run.
    await client.query(`update pilot.session_script_runs set paused_at = now() where run_id = 'run-plain'`);
    await client.query(`update pilot.session_script_runs set paused_at = null, show_on_wall = true where run_id = 'run-plain'`);
    await client.query(
      `update pilot.session_script_runs set run_state = 'completed', ended_at = now(), show_on_wall = false where run_id = 'run-plain'`,
    );
  });

  test('the script and its version go together', async () => {
    await expect(insertRun({ runId: 'run-half-a', scriptId: 'scr-1', scriptVersion: null, blockId: 'blk-1', coach: COACH }))
      .rejects.toThrow(/pilot_ssrun_script_pair/);
    await expect(insertRun({ runId: 'run-half-b', scriptId: null, scriptVersion: 1 }))
      .rejects.toThrow(/pilot_ssrun_script_pair/);
  });

  test('a plain session has no block cursor and is always a tracked run', async () => {
    await expect(insertRun({ runId: 'run-plain-cursor', blockId: 'blk-1' }))
      .rejects.toThrow(/pilot_ssrun_plain_no_cursor/);
    await expect(insertRun({ runId: 'run-plain-legacy', runState: null }))
      .rejects.toThrow(/pilot_ssrun_plain_has_state/);
  });

  test('a live scripted run still needs its cursor, and the script foreign key still binds it', async () => {
    await expect(insertRun({ runId: 'run-scripted-nocursor', scriptId: 'scr-1', scriptVersion: 1, blockId: null }))
      .rejects.toThrow(/pilot_ssrun_cursor_matches_state/);
    await expect(insertRun({ runId: 'run-ghost', scriptId: 'scr-missing', scriptVersion: 1, blockId: 'blk-1' }))
      .rejects.toThrow(/pilot_ssrun_script_fk/);
  });

  test('one live session per coach still holds, plain or scripted', async () => {
    await insertRun({ runId: 'run-plain-live' });
    await expect(insertRun({ runId: 'run-plain-second' })).rejects.toThrow(/pilot_ssrun_one_live_per_coach/);
    await expect(insertRun({ runId: 'run-scripted-second', scriptId: 'scr-1', scriptVersion: 1, blockId: 'blk-1' }))
      .rejects.toThrow(/pilot_ssrun_one_live_per_coach/);
  });

  test('re-running the run-state migration with a live plain session present succeeds (the `all` chain), and so does this one after it', async () => {
    const live = await client.query(`select count(*)::int as n from pilot.session_script_runs where script_id is null and run_state = 'in_progress'`);
    expect(live.rows[0].n).toBeGreaterThan(0);

    await applyRunState(client, runStateSql);
    await applyPlain(client, plainSql);
  });

  test('the runner refuses a result that is missing a guard, and commits nothing', async () => {
    const withoutNoCursor = plainSql.replace(
      /alter table pilot\.session_script_runs\s+add constraint pilot_ssrun_plain_no_cursor[\s\S]*?;\r?\n/,
      '',
    );
    expect(withoutNoCursor).not.toBe(plainSql);
    // Both dropped. The cut-down file re-adds the pair check before readiness refuses, so finding
    // it still absent afterwards proves the refused attempt rolled back (review 1 #3).
    await client.query('alter table pilot.session_script_runs drop constraint pilot_ssrun_plain_no_cursor');
    await client.query('alter table pilot.session_script_runs drop constraint pilot_ssrun_script_pair');

    await expect(applyPlain(client, withoutNoCursor)).rejects.toThrow('SESSION_RUN_PLAIN_NOT_READY');

    const count = async (name: string) => (await client.query(
      `select count(*)::int as n from pg_constraint where conname = $1 and conrelid = to_regclass('pilot.session_script_runs')`,
      [name],
    )).rows[0].n;
    expect(await count('pilot_ssrun_plain_no_cursor')).toBe(0);
    expect(await count('pilot_ssrun_script_pair')).toBe(0);
    await applyPlain(client, plainSql);
    expect(await count('pilot_ssrun_plain_no_cursor')).toBe(1);
    expect(await count('pilot_ssrun_script_pair')).toBe(1);
  });
});
