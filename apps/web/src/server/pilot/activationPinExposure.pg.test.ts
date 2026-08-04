// Real PostgreSQL test for the activation-PIN exposure check.
//
// The property under test IS the narrowing, and it cannot be demonstrated with
// a mock. `must_change_pin = false` is both the exposed state and the normal,
// healthy state of every athlete who has chosen their own PIN, so the whole
// value of this check is whether the audit-trail correlation tells them apart.
// A mocked client would return whatever it was told and prove nothing.
//
// Spins up the same disposable, local-only embedded Postgres the other suites
// use. It NEVER connects to production or staging.

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

const DATA_DIR = path.join(os.tmpdir(), `ppbf-activation-pin-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const CHECK_SCRIPT_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-check-activation-pin-exposure.mjs',
);
const TEST_DB_NAME = 'ppbf_test_activation_pin';

// ts-jest downlevels a plain `await import(...)` into require(), which cannot
// load an ESM-only .mjs file. Building the import() call inside `new Function`
// hides it from that transform, so Node's own ESM loader executes it.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

interface ExposureResult {
  database: string;
  ceiling: number;
  everActivated: number;
  exposed: { account_id: string; organization_id: string; athlete_id: string | null }[];
}

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let checkActivationPinExposure: (client: Client) => Promise<ExposureResult>;
let report: (result: ExposureResult) => string;

function connectionStringFor(database: string): string {
  return `postgres://postgres:postgres@localhost:${PG_PORT}/${database}`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
        return;
      }
      server.close(() => reject(new Error('Could not find a free port')));
    });
    server.on('error', reject);
  });
}

async function testClient(): Promise<Client> {
  const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  return client;
}

let db: Client;

beforeAll(async () => {
  PG_PORT = await freePort();

  // Positional args: the server script takes <dataDir> <port>.
  serverProcess = spawn(
    process.execPath,
    [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessByStdio<null, Readable, Readable>;

  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += String(chunk);
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

  db = await testClient();
  await db.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  await db.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_first_login_pin_migration.sql'), 'utf8'),
  );
  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ('org-1', 'Punxsy Prominence', 'active') on conflict do nothing`,
  );

  const checkModule = await nativeDynamicImport(pathToFileURL(CHECK_SCRIPT_PATH).href);
  checkActivationPinExposure = checkModule.checkActivationPinExposure as typeof checkActivationPinExposure;
  report = checkModule.report as typeof report;
});

afterAll(async () => {
  await db?.end().catch(() => {});

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

async function account(
  accountId: string,
  { mustChange = false, active = true, hasPin = true, role = 'athlete' } = {},
): Promise<void> {
  await db.query(
    `insert into pilot.accounts
       (account_id, role, organization_id, athlete_id, pin_hash, must_change_pin,
        active_flag, is_platform_owner, auth_provider)
     values ($1, $2, 'org-1', $3, $4, $5, $6, false, 'ppbf_local')`,
    [accountId, role, `ath-${accountId}`, hasPin ? 'hashed' : null, mustChange, active],
  );
}

/** An audit row of the shape the real route writes, at a controlled time. */
async function auditEvent(accountId: string, action: string, minutesAgo: number): Promise<void> {
  await db.query(
    `insert into pilot.audit_events
       (event_type, actor_account_id, actor_role, organization_id, entity_type, entity_id, details, created_at)
     values ('update', 'admin-1', 'organization_admin', 'org-1', 'account', $1, $2::jsonb,
             now() - ($3::int * interval '1 minute'))`,
    [accountId, JSON.stringify({ action }), minutesAgo],
  );
}

async function exposedIds(): Promise<string[]> {
  const client = await testClient();
  try {
    const result = await checkActivationPinExposure(client);
    return result.exposed.map((row) => row.account_id).sort();
  } finally {
    await client.end();
  }
}

describe('an empty database', () => {
  it('reports nothing to remediate, and says why the list is empty', async () => {
    const client = await testClient();
    const result = await checkActivationPinExposure(client);
    await client.end();

    expect(result.exposed).toEqual([]);
    expect(result.everActivated).toBe(0);
    // "Nobody was ever activated" and "everybody has since chosen their own"
    // both produce an empty list and mean very different things.
    expect(report(result)).toMatch(/never been activated|has ever been activated/i);
  });
});

describe('telling an exposed account from a healthy one', () => {
  beforeAll(async () => {
    // THE FINDING: activated by an admin, never replaced.
    await account('exposed-1');
    await auditEvent('exposed-1', 'pin_activate', 60);

    // HEALTHY, and the reason the coarse query is useless on its own: this
    // account also sits at must_change_pin = false, because choosing your own
    // PIN is exactly what clears the flag.
    await account('changed-after');
    await auditEvent('changed-after', 'pin_activate', 60);
    await auditEvent('changed-after', 'change_own_pin', 30);

    // HEALTHY: never went through activation at all. Created live on the
    // bootstrap PIN and changed it, which is the /admin/people path.
    await account('self-serve');
    await auditEvent('self-serve', 'change_own_pin', 30);

    // NOT A FINDING: already being forced to change, so the guard is working.
    await account('already-forced', { mustChange: true });
    await auditEvent('already-forced', 'pin_activate', 60);

    // NOT A FINDING: deactivated, so it cannot sign in at all.
    await account('deactivated', { active: false });
    await auditEvent('deactivated', 'pin_activate', 60);

    // NOT A FINDING: no credential on the row, so there is nothing to hold.
    await account('no-pin', { hasPin: false });
    await auditEvent('no-pin', 'pin_activate', 60);
  });

  it('reports only the account still holding the administrator PIN', async () => {
    expect(await exposedIds()).toEqual(['exposed-1']);
  });

  it('counts the ceiling separately, and it is much larger than the finding', async () => {
    const client = await testClient();
    const result = await checkActivationPinExposure(client);
    await client.end();

    // exposed-1, changed-after, self-serve, no-pin is excluded (null pin),
    // deactivated is excluded (inactive), already-forced is excluded (flag).
    expect(result.ceiling).toBeGreaterThan(result.exposed.length);
    // The distinction the report has to make in words, or the number gets
    // dismissed on first reading.
    expect(report(result)).toMatch(/ceiling, not a finding/i);
  });

  // The ordering case a naive `not exists (any change_own_pin)` gets wrong: an
  // athlete who chose a PIN, then had their account re-activated by an admin
  // later, is exposed again. The change is real but it predates the new PIN.
  it('reports an account re-activated after it had chosen its own PIN', async () => {
    await account('changed-then-reactivated');
    await auditEvent('changed-then-reactivated', 'pin_activate', 500);
    await auditEvent('changed-then-reactivated', 'change_own_pin', 400);
    await auditEvent('changed-then-reactivated', 'pin_activate', 10);

    expect(await exposedIds()).toEqual(['changed-then-reactivated', 'exposed-1']);
  });

  it('stops reporting an account once its athlete chooses a PIN', async () => {
    await auditEvent('exposed-1', 'change_own_pin', 1);

    expect(await exposedIds()).toEqual(['changed-then-reactivated']);
  });
});

describe('it writes nothing', () => {
  // The transaction is READ ONLY, so Postgres refuses a write rather than the
  // script merely not attempting one. Asserted because this is the property
  // that makes the script safe to point at production.
  it('runs inside a read-only transaction', async () => {
    const client = await testClient();
    await client.query('BEGIN TRANSACTION READ ONLY');
    await expect(
      client.query("insert into pilot.organizations (organization_id, organization_name, status) values ('x','X','active')"),
    ).rejects.toThrow(/read-only/i);
    await client.query('ROLLBACK');
    await client.end();
  });

  it('leaves every must_change_pin flag exactly as it found it', async () => {
    const before = await db.query('select account_id, must_change_pin from pilot.accounts order by account_id');

    const client = await testClient();
    await checkActivationPinExposure(client);
    await client.end();

    const after = await db.query('select account_id, must_change_pin from pilot.accounts order by account_id');
    expect(after.rows).toEqual(before.rows);
  });
});
