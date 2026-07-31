// Real PostgreSQL-backed test for repairStrandedGuardianAuthProvider.
//
// The repair is one UPDATE whose entire safety story lives in its WHERE
// clause -- org scope, non-athlete, ppbf_local-only, active-only, email
// present. That is exactly the class of real-SQL guard a mock cannot pin
// (the worker's claim bug shipped green through mocks, #89), so every guard
// is exercised here against the real pilot.accounts table.
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

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-guardian-repair-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_guardian_repair';

const ORG_A = 'org-repair-a';
const ORG_B = 'org-repair-b';
const STRANDED_PARENT = 'acct-stranded-parent';
const STRANDED_NO_EMAIL = 'acct-stranded-no-email';
const STRANDED_INACTIVE = 'acct-stranded-inactive';
const LOCAL_ATHLETE = 'acct-local-athlete';
const MICROSOFT_PARENT = 'acct-ms-parent';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let auth: typeof import('./auth');
let db: typeof import('./db');

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

async function accountRow(accountId: string): Promise<{
  auth_provider: string;
  pin_hash: string | null;
  must_change_pin: boolean;
}> {
  const row = await db.queryOne<{
    auth_provider: string;
    pin_hash: string | null;
    must_change_pin: boolean;
  }>(
    'select auth_provider, pin_hash, must_change_pin from pilot.accounts where account_id = $1',
    [accountId],
  );
  if (!row) throw new Error(`fixture account missing: ${accountId}`);
  return row;
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
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  const migrateClient = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrateClient.connect();
  // pilot.accounts (auth_provider, organization_id, active_flag, pin_hash) is
  // entirely base-schema; no incremental migration participates in this
  // repair, so none is applied.
  await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  for (const orgId of [ORG_A, ORG_B]) {
    await migrateClient.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
  }
  const seedAccounts: Array<[string, string, string, string, string | null, string | null, boolean]> = [
    // [account_id, role, org, auth_provider, login_email, pin_hash, active]
    [STRANDED_PARENT, 'parent', ORG_A, 'ppbf_local', 'stranded-parent@example.org', 'legacy-hash', true],
    [STRANDED_NO_EMAIL, 'parent', ORG_A, 'ppbf_local', null, 'legacy-hash', true],
    [STRANDED_INACTIVE, 'parent', ORG_A, 'ppbf_local', 'stranded-inactive@example.org', 'legacy-hash', false],
    [LOCAL_ATHLETE, 'athlete', ORG_A, 'ppbf_local', 'local-athlete@example.org', 'athlete-hash', true],
    [MICROSOFT_PARENT, 'parent', ORG_A, 'microsoft', 'ms-parent@example.org', null, true],
  ];
  for (const [accountId, role, orgId, provider, email, pinHash, active] of seedAccounts) {
    await migrateClient.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, login_email, pin_hash, active_flag)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [accountId, role, orgId, provider, email, pinHash, active],
    );
  }
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  db = await import('./db');
  auth = await import('./auth');
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool();

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
});

describe('repairStrandedGuardianAuthProvider against the real schema', () => {
  test('repairs a stranded parent: provider flipped, dead pin cleared', async () => {
    const result = await auth.repairStrandedGuardianAuthProvider(STRANDED_PARENT, ORG_A);
    expect(result).toEqual({
      account_id: STRANDED_PARENT,
      role: 'parent',
      login_email: 'stranded-parent@example.org',
    });

    const row = await accountRow(STRANDED_PARENT);
    expect(row.auth_provider).toBe('microsoft');
    expect(row.pin_hash).toBeNull();
    expect(row.must_change_pin).toBe(false);
  });

  test('a repaired account is not repairable twice', async () => {
    await expect(auth.repairStrandedGuardianAuthProvider(STRANDED_PARENT, ORG_A))
      .rejects.toThrow(/Not found/);
  });

  test('refuses athletes: ppbf_local is their legitimate provider', async () => {
    await expect(auth.repairStrandedGuardianAuthProvider(LOCAL_ATHLETE, ORG_A))
      .rejects.toThrow(/Not found/);
    const row = await accountRow(LOCAL_ATHLETE);
    expect(row.auth_provider).toBe('ppbf_local');
    expect(row.pin_hash).toBe('athlete-hash');
  });

  test('refuses cross-organization repair', async () => {
    await expect(auth.repairStrandedGuardianAuthProvider(STRANDED_NO_EMAIL, ORG_B))
      .rejects.toThrow(/Not found/);
  });

  test('refuses a stranded row with no login email: nothing for Microsoft sign-in to match', async () => {
    await expect(auth.repairStrandedGuardianAuthProvider(STRANDED_NO_EMAIL, ORG_A))
      .rejects.toThrow(/Not found/);
    const row = await accountRow(STRANDED_NO_EMAIL);
    expect(row.auth_provider).toBe('ppbf_local');
  });

  test('refuses inactive accounts', async () => {
    await expect(auth.repairStrandedGuardianAuthProvider(STRANDED_INACTIVE, ORG_A))
      .rejects.toThrow(/Not found/);
  });

  test('refuses an account already on microsoft', async () => {
    await expect(auth.repairStrandedGuardianAuthProvider(MICROSOFT_PARENT, ORG_A))
      .rejects.toThrow(/Not found/);
  });
});
