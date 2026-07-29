// Real PostgreSQL-backed tests for the deploy gates' session minter
// (scripts/lib/gate-session.mjs).
//
// The gates could not authenticate at all: they signed in with an account id
// and a PIN, but PIN sessions are athlete-only, so no administrator or
// guardian fixture could ever hold one. The minter replaces that by writing a
// short-lived row to pilot.session_tokens directly.
//
// Its refusals are the point of testing it. A gate that fails with "401" tells
// an operator nothing; each guard below exists so a misconfigured fixture
// reports which specific precondition it violates. If these regress, the gates
// become undiagnosable again rather than merely broken.
//
// Uses the same disposable, local-only embedded Postgres instance as the other
// .pg tests. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-gate-session-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const GATE_SESSION_PATH = path.resolve(__dirname, '../../../scripts/lib/gate-session.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_gate_session';
const ORG_ID = 'org-gate';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let mintGateSession: (input: {
  connectionString: string;
  accountId: string;
  expectedRole?: string;
  ttlMinutes?: number;
}) => Promise<{
  token: string;
  cookie: string;
  organizationId: string;
  role: string;
  revoke: () => Promise<void>;
}>;

// ts-jest downlevels a plain `await import()` into require(), which cannot load
// this ESM-only .mjs file. Hiding the import inside `new Function` keeps it a
// genuine dynamic import executed by Node's own ESM loader.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

// The minter always requests TLS, which this disposable instance does not
// serve, so tests pass a connection string that disables it. Production callers
// get the module's own `ssl: { rejectUnauthorized: true }`.
function testConnectionString(): string {
  return `${connectionStringFor(TEST_DB_NAME)}?sslmode=disable`;
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

async function rawQuery<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end();
  }
}

async function makeAccount(input: {
  accountId: string;
  role: string;
  authProvider?: 'ppbf_local' | 'microsoft';
  activeFlag?: boolean;
  withMembership?: boolean;
}): Promise<void> {
  await rawQuery(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
     values ($1, $2, $3, $4, $5)
     on conflict (account_id) do update
       set role = excluded.role,
           auth_provider = excluded.auth_provider,
           active_flag = excluded.active_flag`,
    [input.accountId, input.role, ORG_ID, input.authProvider ?? 'microsoft', input.activeFlag ?? true],
  );

  if (input.withMembership ?? true) {
    await rawQuery(
      `insert into pilot.organization_memberships (account_id, organization_id, role, active_flag)
       values ($1, $2, $3, true) on conflict do nothing`,
      [input.accountId, ORG_ID, input.role],
    );
  }
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

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  const migrate = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await migrate.connect();
  await migrate.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  await migrate.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await migrate.end();

  ({ mintGateSession } = (await nativeDynamicImport(GATE_SESSION_PATH)) as never);
});

afterAll(async () => {
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

describe('mintGateSession', () => {
  test('mints a usable session for a Microsoft-authenticated admin', async () => {
    await makeAccount({ accountId: 'gate-admin', role: 'organization_admin' });

    const session = await mintGateSession({
      connectionString: testConnectionString(),
      accountId: 'gate-admin',
      expectedRole: 'organization_admin',
    });

    expect(session.cookie).toBe(`ppbf_pilot_session=${session.token}`);
    expect(session.organizationId).toBe(ORG_ID);

    // The row must be keyed by the hash, never the token itself.
    const rows = await rawQuery<{ token_hash: string; revoked_at: string | null }>(
      'select token_hash, revoked_at from pilot.session_tokens where account_id = $1',
      ['gate-admin'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(createHash('sha256').update(session.token).digest('hex'));
    expect(rows[0].revoked_at).toBeNull();
  });

  test('revoke() actually revokes, so a failed gate leaves nothing live', async () => {
    await makeAccount({ accountId: 'gate-admin-2', role: 'organization_admin' });

    const session = await mintGateSession({
      connectionString: testConnectionString(),
      accountId: 'gate-admin-2',
    });
    await session.revoke();

    const rows = await rawQuery<{ revoked_at: string | null }>(
      'select revoked_at from pilot.session_tokens where account_id = $1',
      ['gate-admin-2'],
    );
    expect(rows[0].revoked_at).not.toBeNull();
  });

  test('expires well inside the 24h absolute session lifetime', async () => {
    await makeAccount({ accountId: 'gate-admin-3', role: 'organization_admin' });

    await mintGateSession({
      connectionString: testConnectionString(),
      accountId: 'gate-admin-3',
      ttlMinutes: 30,
    });

    const rows = await rawQuery<{ within_the_hour: boolean }>(
      `select expires_at < now() + interval '1 hour' as within_the_hour
       from pilot.session_tokens where account_id = $1`,
      ['gate-admin-3'],
    );
    expect(rows[0].within_the_hour).toBe(true);
  });

  describe('refusals name the precondition that failed', () => {
    test('refuses a local PIN account with a privileged role', async () => {
      // This is the case the gates actually hit. resolvePrincipal revokes any
      // ppbf_local non-athlete session on sight, so minting one would produce a
      // session destroyed by its own first use -- an unexplained 401.
      await makeAccount({ accountId: 'gate-local-parent', role: 'parent', authProvider: 'ppbf_local' });

      await expect(mintGateSession({
        connectionString: testConnectionString(),
        accountId: 'gate-local-parent',
      })).rejects.toThrow(/local \(PIN\) account/);

      // The message must also say what to do about it, not just what is wrong.
      await expect(mintGateSession({
        connectionString: testConnectionString(),
        accountId: 'gate-local-parent',
      })).rejects.toThrow(/must be Microsoft-authenticated/);
    });

    test('refuses an account that does not exist', async () => {
      await expect(mintGateSession({
        connectionString: testConnectionString(),
        accountId: 'gate-missing',
      })).rejects.toThrow(/does not exist/);
    });

    test('refuses a role mismatch', async () => {
      await makeAccount({ accountId: 'gate-coach', role: 'coach' });

      await expect(mintGateSession({
        connectionString: testConnectionString(),
        accountId: 'gate-coach',
        expectedRole: 'organization_admin',
      })).rejects.toThrow(/has role "coach", expected "organization_admin"/);
    });

    test('refuses an account with no active membership', async () => {
      // resolvePrincipal joins organization_memberships, so this would 401 with
      // nothing indicating the membership is what is missing.
      await makeAccount({ accountId: 'gate-nomember', role: 'organization_admin', withMembership: false });

      await expect(mintGateSession({
        connectionString: testConnectionString(),
        accountId: 'gate-nomember',
      })).rejects.toThrow(/no active membership/);
    });

    test('refuses an inactive account', async () => {
      await makeAccount({ accountId: 'gate-inactive', role: 'organization_admin', activeFlag: false });

      await expect(mintGateSession({
        connectionString: testConnectionString(),
        accountId: 'gate-inactive',
      })).rejects.toThrow(/is inactive/);
    });

    test('writes no session row when it refuses', async () => {
      await makeAccount({ accountId: 'gate-refused', role: 'coach' });

      await expect(mintGateSession({
        connectionString: testConnectionString(),
        accountId: 'gate-refused',
        expectedRole: 'organization_admin',
      })).rejects.toThrow();

      const rows = await rawQuery('select 1 from pilot.session_tokens where account_id = $1', ['gate-refused']);
      expect(rows).toHaveLength(0);
    });
  });
});
