/**
 * The nightly session-token cleanup, on real PostgreSQL, through the script
 * the workflow runs (scripts/pilot-cleanup-sessions.ts via tsx).
 *
 * docs/DATA_RETENTION.md: "Session tokens | 30 days after
 * expiration/revocation". A token is due when its expires_at, or its
 * revoked_at, is more than SESSION_TOKEN_RETENTION_DAYS (30) days old. The
 * script is a dry run unless PPBF_SESSION_CLEANUP_APPLY=true, and refuses a
 * database the caller did not name.
 *
 * Spins up the same disposable, local-only embedded Postgres the other
 * migration suites use. It NEVER connects to production or staging.
 */

import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
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
const PG_DATABASE = 'ppbf_test_session_token_cleanup';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-session-token-cleanup-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const WEB_DIR = path.resolve(__dirname, '../../..');
const CLEANUP_SCRIPT = path.join(WEB_DIR, 'scripts/pilot-cleanup-sessions.ts');
const TSX = path.resolve(WEB_DIR, '../../node_modules/.bin/tsx');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-session-cleanup';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
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
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error('Could not determine a free port')));
      }
    });
  });
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
  await admin.query(`drop database if exists ${PG_DATABASE}`);
  await admin.query(`create database ${PG_DATABASE}`);
  await admin.end();

  client = new Client({ connectionString: connectionStringFor(PG_DATABASE) });
  await client.connect();
  const { applyFullSchema } = (await nativeDynamicImport(
    pathToFileURL(FULL_SCHEMA_HELPER_PATH).href,
  )) as { applyFullSchema: (c: Client) => Promise<void> };
  await applyFullSchema(client);

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
});

afterAll(async () => {
  await client?.end();
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

interface RunResult {
  code: number | null;
  event: Record<string, unknown>;
  stdout: string;
  stderr: string;
}

async function run(env: Record<string, string>, args: string[] = []): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      TSX,
      [CLEANUP_SCRIPT, ...args],
      {
        cwd: WEB_DIR,
        env: {
          ...process.env,
          AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(PG_DATABASE),
          PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
          PPBF_EXPECTED_POSTGRES_DATABASE: PG_DATABASE,
          PPBF_POSTGRES_DISABLE_SSL: 'true',
          ...env,
        },
      },
      (error, stdout, stderr) => {
        const line = `${stdout}${stderr}`.split('\n').find((entry) => entry.trim().startsWith('{'));
        resolve({
          code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
          event: JSON.parse(line ?? '{}') as Record<string, unknown>,
          stdout,
          stderr,
        });
      },
    );
  });
}

const TOKENS = {
  live: { expires: "now() + interval '12 hours'", revoked: 'null' },
  expired10: { expires: "now() - interval '10 days'", revoked: 'null' },
  expired40: { expires: "now() - interval '40 days'", revoked: 'null' },
  revoked10: { expires: "now() + interval '12 hours'", revoked: "now() - interval '10 days'" },
  revoked40: { expires: "now() + interval '12 hours'", revoked: "now() - interval '40 days'" },
} as const;

async function tokensLeft(): Promise<string[]> {
  const rows = await client.query<{ token_hash: string }>(
    'select token_hash from pilot.session_tokens where organization_id = $1 order by token_hash',
    [ORG_ID],
  );
  return rows.rows.map((row) => row.token_hash);
}

beforeEach(async () => {
  await client.query('delete from pilot.session_tokens where organization_id = $1', [ORG_ID]);
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ('acct-session-cleanup', 'coach', $1, 'microsoft') on conflict do nothing`,
    [ORG_ID],
  );
  for (const [name, at] of Object.entries(TOKENS)) {
    await client.query(
      `insert into pilot.session_tokens (token_hash, account_id, organization_id, expires_at, revoked_at)
       values ($1, 'acct-session-cleanup', $2, ${at.expires}, ${at.revoked})`,
      [name, ORG_ID],
    );
  }
});

const ALL = Object.keys(TOKENS).sort();

test('the dry run counts the tokens past 30 days and deletes nothing', async () => {
  const result = await run({});
  expect(result.code).toBe(0);
  expect(result.event).toEqual(expect.objectContaining({
    event: 'session.cleanup.dry_run',
    retention_days: 30,
    would_delete: 2,
  }));
  expect(await tokensLeft()).toEqual(ALL);
});

test('APPLY deletes only tokens expired or revoked more than 30 days ago', async () => {
  const result = await run({ PPBF_SESSION_CLEANUP_APPLY: 'true' });
  expect(result.code).toBe(0);
  expect(result.event).toEqual({ event: 'session.cleanup.applied', retention_days: 30, deleted: 2 });
  expect(await tokensLeft()).toEqual(['expired10', 'live', 'revoked10']);
});

test('only the exact string true applies', async () => {
  const result = await run({ PPBF_SESSION_CLEANUP_APPLY: 'TRUE' });
  expect(result.event.event).toBe('session.cleanup.dry_run');
  expect(await tokensLeft()).toEqual(ALL);
});

test('a window given on the command line is used, and a malformed one refused', async () => {
  const wider = await run({ PPBF_SESSION_CLEANUP_APPLY: 'true' }, ['5']);
  expect(wider.event).toEqual({ event: 'session.cleanup.applied', retention_days: 5, deleted: 4 });
  expect(await tokensLeft()).toEqual(['live']);

  const bad = await run({ PPBF_SESSION_CLEANUP_APPLY: 'true' }, ['7abc']);
  expect(bad.code).not.toBe(0);
  expect(bad.event.event).toBe('session.cleanup.failed');
});

test('a database the caller did not name is refused before anything is read or deleted', async () => {
  const result = await run({ PPBF_SESSION_CLEANUP_APPLY: 'true', PPBF_EXPECTED_POSTGRES_DATABASE: 'some_other_db' });
  expect(result.code).not.toBe(0);
  expect(result.event.event).toBe('session.cleanup.refused');
  // The refusal names a token, never the connection string.
  expect(`${result.stdout}${result.stderr}`).not.toContain('postgres:postgres@');
  expect(await tokensLeft()).toEqual(ALL);
});

test('no token hash or account id reaches the output', async () => {
  const dry = await run({});
  const applied = await run({ PPBF_SESSION_CLEANUP_APPLY: 'true' });
  for (const output of [dry, applied].map((r) => `${r.stdout}${r.stderr}`)) {
    expect(output).not.toContain('acct-session-cleanup');
    for (const name of Object.keys(TOKENS)) expect(output).not.toContain(name);
  }
});
