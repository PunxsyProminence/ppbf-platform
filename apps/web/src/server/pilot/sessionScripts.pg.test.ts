// Real PostgreSQL-backed contract test for sessionScripts.ts running against a
// real transaction. The migration itself is covered by
// sessionScriptsTransfer.pg.test.ts; this suite covers the READ MODULE, whose
// SQL is otherwise never executed anywhere.
//
// Four things need proving, and none can be proven by reading the SQL or by a
// mocked-query unit test:
//
// 1. getSessionScriptWithDetail orders blocks by block_order, and keeps that
//    order when two blocks share a start_offset_min -- ordering by offset
//    would make their sequence arbitrary, and the coach runs them in order.
// 2. listSessionScripts hides retired scripts by default and returns them when
//    asked, rather than dropping them from the database's view entirely.
// 3. Every filter is genuinely a filter: a null parameter must not narrow the
//    result set (the `$n::text is null or col = $n` idiom silently returns
//    nothing if a cast is wrong).
// 4. The module is organization-scoped: another org's script is invisible even
//    when its script_id is known and passed directly.
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

import { getSessionScriptWithDetail, listSessionScripts } from './sessionScripts';

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
}));

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-scripts-module-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_session_scripts_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-session-scripts-migration.mjs',
);

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

async function insertScript(opts: {
  organizationId: string;
  scriptId: string;
  createdBy: string;
  name?: string;
  discipline?: string;
  phase?: string | null;
  dayOfWeek?: string | null;
  authoringState?: string;
}): Promise<void> {
  await client.query(
    `insert into pilot.session_scripts
       (organization_id, script_id, lineage_id, version, name, discipline, phase, day_of_week,
        authoring_state, created_by_account_id)
     values ($1,$2,$2,1,$3,$4,$5,$6,$7,$8)`,
    [
      opts.organizationId,
      opts.scriptId,
      opts.name ?? `Script ${opts.scriptId}`,
      opts.discipline ?? 'boxing',
      opts.phase ?? null,
      opts.dayOfWeek ?? null,
      opts.authoringState ?? 'in_use',
      opts.createdBy,
    ],
  );
}

async function insertBlock(opts: {
  organizationId: string;
  scriptId: string;
  blockId: string;
  order: number;
  start: number;
  end: number;
  label: string;
}): Promise<void> {
  await client.query(
    `insert into pilot.session_script_blocks
       (organization_id, block_id, script_id, block_order, start_offset_min, end_offset_min,
        block_label, what_to_watch, block_kind)
     values ($1,$2,$3,$4,$5,$6,$7,'watch this','instruction')`,
    [opts.organizationId, opts.blockId, opts.scriptId, opts.order, opts.start, opts.end, opts.label],
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

  prerequisiteSchemaSql = await Promise.all(
    ['pilot_slice_postgres.sql', 'pilot_slice_postgres_drill_library_v3_migration.sql']
      .map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    c: Client,
    sql: string,
  ) => Promise<void>;

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query('drop database if exists ppbf_test_session_scripts_module');
  await admin.query('create database ppbf_test_session_scripts_module');
  await admin.end();

  client = new Client({ connectionString: connectionStringFor('ppbf_test_session_scripts_module') });
  await client.connect();
  for (const sql of prerequisiteSchemaSql) {
    await client.query(sql);
  }
  await applyMigrationTransaction(client, migrationSql);

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
  await client.query('delete from pilot.session_script_blocks');
  await client.query('delete from pilot.session_scripts');
});

describe('getSessionScriptWithDetail against real Postgres', () => {
  test('returns blocks in block_order even when two share a start offset', async () => {
    await insertScript({ organizationId: ORG_A, scriptId: 'scr-1', createdBy: COACH_A });
    // Inserted deliberately out of order, and the later block_order has the
    // EARLIER end offset, so any ordering other than block_order shows up.
    await insertBlock({ organizationId: ORG_A, scriptId: 'scr-1', blockId: 'b-2', order: 2, start: 30, end: 40, label: 'second' });
    await insertBlock({ organizationId: ORG_A, scriptId: 'scr-1', blockId: 'b-1', order: 1, start: 30, end: 45, label: 'first' });

    const detail = await getSessionScriptWithDetail(ORG_A, 'scr-1');

    expect(detail?.blocks.map((b) => b.block_label)).toEqual(['first', 'second']);
  });

  test('returns null for a script that belongs to another organization', async () => {
    await insertScript({ organizationId: ORG_B, scriptId: 'scr-other', createdBy: COACH_B });

    // The script_id is real and correct -- only the organization is wrong.
    expect(await getSessionScriptWithDetail(ORG_A, 'scr-other')).toBeNull();
  });

  test('returns a script with no blocks rather than null', async () => {
    await insertScript({ organizationId: ORG_A, scriptId: 'scr-empty', createdBy: COACH_A });

    const detail = await getSessionScriptWithDetail(ORG_A, 'scr-empty');

    expect(detail).not.toBeNull();
    expect(detail?.blocks).toEqual([]);
    expect(detail?.renderings).toEqual([]);
  });

  test('never returns another organization\'s blocks under this organization\'s script', async () => {
    await insertScript({ organizationId: ORG_A, scriptId: 'shared-id', createdBy: COACH_A });
    await insertScript({ organizationId: ORG_B, scriptId: 'shared-id', createdBy: COACH_B });
    await insertBlock({ organizationId: ORG_A, scriptId: 'shared-id', blockId: 'a-block', order: 1, start: 0, end: 10, label: 'ours' });
    await insertBlock({ organizationId: ORG_B, scriptId: 'shared-id', blockId: 'b-block', order: 1, start: 0, end: 10, label: 'theirs' });

    const detail = await getSessionScriptWithDetail(ORG_A, 'shared-id');

    expect(detail?.blocks.map((b) => b.block_label)).toEqual(['ours']);
  });
});

describe('listSessionScripts against real Postgres', () => {
  test('hides retired scripts by default but keeps them in the database', async () => {
    await insertScript({ organizationId: ORG_A, scriptId: 'scr-live', createdBy: COACH_A, authoringState: 'in_use' });
    await insertScript({ organizationId: ORG_A, scriptId: 'scr-old', createdBy: COACH_A, authoringState: 'retired' });

    const visible = await listSessionScripts(ORG_A);
    expect(visible.map((s) => s.script_id)).toEqual(['scr-live']);

    const all = await listSessionScripts(ORG_A, { includeRetired: true });
    expect(all.map((s) => s.script_id).sort()).toEqual(['scr-live', 'scr-old']);
  });

  test('an unset filter does not narrow the result set', async () => {
    // The `$n::text is null or col = $n` idiom returns NOTHING if the cast is
    // wrong, which reads exactly like an empty library.
    await insertScript({ organizationId: ORG_A, scriptId: 'scr-1', createdBy: COACH_A, phase: null, dayOfWeek: null });

    expect(await listSessionScripts(ORG_A)).toHaveLength(1);
    expect(await listSessionScripts(ORG_A, {})).toHaveLength(1);
  });

  test('each filter actually filters', async () => {
    await insertScript({ organizationId: ORG_A, scriptId: 'scr-fri', createdBy: COACH_A, dayOfWeek: 'friday', phase: 'taper', discipline: 'boxing' });
    await insertScript({ organizationId: ORG_A, scriptId: 'scr-tue', createdBy: COACH_A, dayOfWeek: 'tuesday', phase: 'accumulation', discipline: 'grappling' });

    expect((await listSessionScripts(ORG_A, { dayOfWeek: 'friday' })).map((s) => s.script_id)).toEqual(['scr-fri']);
    expect((await listSessionScripts(ORG_A, { phase: 'accumulation' })).map((s) => s.script_id)).toEqual(['scr-tue']);
    expect((await listSessionScripts(ORG_A, { discipline: 'grappling' })).map((s) => s.script_id)).toEqual(['scr-tue']);
    expect((await listSessionScripts(ORG_A, { authoringState: 'in_use' }))).toHaveLength(2);
  });

  test('does not leak another organization\'s scripts', async () => {
    await insertScript({ organizationId: ORG_A, scriptId: 'scr-ours', createdBy: COACH_A });
    await insertScript({ organizationId: ORG_B, scriptId: 'scr-theirs', createdBy: COACH_B });

    expect((await listSessionScripts(ORG_A)).map((s) => s.script_id)).toEqual(['scr-ours']);
  });

  test('a retired-only filter combined with the default still returns nothing', async () => {
    // authoring_state='retired' AND the default retired exclusion is a genuine
    // contradiction; it must return empty rather than quietly ignoring one.
    await insertScript({ organizationId: ORG_A, scriptId: 'scr-old', createdBy: COACH_A, authoringState: 'retired' });

    expect(await listSessionScripts(ORG_A, { authoringState: 'retired' })).toEqual([]);
    expect(await listSessionScripts(ORG_A, { authoringState: 'retired', includeRetired: true })).toHaveLength(1);
  });
});
