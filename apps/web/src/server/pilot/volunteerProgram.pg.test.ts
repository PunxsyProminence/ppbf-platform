// Real PostgreSQL-backed test for volunteers.ts.
//
// This module's INSERT is the exact statement that failed 100% of the time
// from the day the feature shipped (#113): it wrote five columns the live
// table did not have, and the textual schema-contract test that now guards
// registration cannot execute SQL. This suite runs the real statements
// against base schema + volunteer-program migration, per the post-#89
// real-SQL policy (audit finding F2).
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-volunteer-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_volunteers';

const ORG_A = 'org-vol-a';
const ORG_B = 'org-vol-b';

const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-volunteer-program-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let volunteers: typeof import('./volunteers');
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
  await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
  // The volunteer-program runner opens its own transaction (opposite
  // convention from shadow-runtime, pinned by the schema-contract tests), so
  // the file applies here as plain statements exactly as the runner sends it.
  await migrateClient.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_volunteer_program_migration.sql'), 'utf8'),
  );
  for (const orgId of [ORG_A, ORG_B]) {
    await migrateClient.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [orgId],
    );
  }
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  db = await import('./db');
  volunteers = await import('./volunteers');
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

describe('volunteers.ts against the real schema', () => {
  let volunteerId: string;

  test('createVolunteer inserts the historically-failing statement successfully', async () => {
    volunteerId = await volunteers.createVolunteer({
      organizationId: ORG_A,
      fullName: 'Vol A One',
      roleFocus: 'corner-coach',
      availability: 'weeknights',
      certificationStatus: 'pending',
      backgroundCheckStatus: 'submitted',
      notes: 'first volunteer',
    });
    expect(volunteerId).toMatch(/^[0-9a-f-]{36}$/);

    const record = await volunteers.getVolunteer(ORG_A, volunteerId);
    expect(record).toMatchObject({
      volunteer_id: volunteerId,
      organization_id: ORG_A,
      full_name: 'Vol A One',
      role_focus: 'corner-coach',
      availability: 'weeknights',
      certification_status: 'pending',
      background_check_status: 'submitted',
      status: 'pending',
      notes: 'first volunteer',
      account_id: null,
    });
  });

  test('a new volunteer is pending and inactive until reviewed', async () => {
    const row = await db.queryOne<{ status: string; active_flag: boolean; role: string }>(
      'select status, active_flag, role from pilot.volunteers where organization_id = $1 and volunteer_id = $2',
      [ORG_A, volunteerId],
    );
    expect(row).toEqual({ status: 'pending', active_flag: false, role: 'corner-coach' });
  });

  test('updateVolunteerStatus flips status and keeps active_flag truthful', async () => {
    const updated = await volunteers.updateVolunteerStatus({
      organizationId: ORG_A,
      volunteerId,
      status: 'active',
    });
    expect(updated).toBe(true);

    const row = await db.queryOne<{ status: string; active_flag: boolean }>(
      'select status, active_flag from pilot.volunteers where organization_id = $1 and volunteer_id = $2',
      [ORG_A, volunteerId],
    );
    expect(row).toEqual({ status: 'active', active_flag: true });
  });

  test('cross-organization reads and updates refuse', async () => {
    expect(await volunteers.getVolunteer(ORG_B, volunteerId)).toBeNull();
    expect(
      await volunteers.updateVolunteerStatus({ organizationId: ORG_B, volunteerId, status: 'inactive' }),
    ).toBe(false);

    const row = await db.queryOne<{ status: string }>(
      'select status from pilot.volunteers where organization_id = $1 and volunteer_id = $2',
      [ORG_A, volunteerId],
    );
    expect(row?.status).toBe('active');
  });

  test('listVolunteers is organization-scoped', async () => {
    await volunteers.createVolunteer({
      organizationId: ORG_B,
      fullName: 'Vol B One',
      roleFocus: 'equipment',
      availability: 'weekends',
      certificationStatus: 'complete',
      backgroundCheckStatus: 'clear',
    });

    const orgA = await volunteers.listVolunteers(ORG_A);
    const orgB = await volunteers.listVolunteers(ORG_B);
    expect(orgA.map((v) => v.full_name)).toEqual(['Vol A One']);
    expect(orgB.map((v) => v.full_name)).toEqual(['Vol B One']);
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// The suite above migrates one database in beforeAll with a plain
// `client.query` and then tests the module on top of it. That proves the
// schema and proves nothing about scripts/pilot-apply-volunteer-program-migration.mjs's
// READINESS_QUERY -- the assertion that gates the actual dispatch, and the
// only code in this migration whose first real execution is against a live
// environment at the most expensive possible moment.
//
// #488 is what that costs: a readiness check that searched
// pg_get_constraintdef() for the literal `between 1 and 5` could not pass on
// ANY database, because Postgres deparses a CHECK from the parsed tree and
// emits `>= 1 AND <= 5`. The schema was correct the whole time. Only a real
// staging dispatch found it.
//
// The query is never restated here -- `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so this
// cannot stay green while the runner rots. It brings its own disposable
// database so the migrated one the module tests run against is untouched.
describe('volunteer program runner readiness assertion', () => {
  async function runnerDatabase(name: string): Promise<Client> {
    const admin = new Client({ connectionString: connectionStringFor('postgres') });
    await admin.connect();
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name}`);
    await admin.end();

    const client = new Client({ connectionString: connectionStringFor(name) });
    await client.connect();
      await client.query(await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8'));
    return client;
  }

  async function loadRunner(): Promise<(client: Client, sql: string) => Promise<void>> {
    const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
    return runnerModule.applyMigrationTransaction as (client: Client, sql: string) => Promise<void>;
  }

  test('the real runner REFUSES a database where the migration never ran', async () => {
    const applyMigrationTransaction = await loadRunner();
    const client = await runnerDatabase('ppbf_test_volp_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /VOLUNTEER_PROGRAM_COLUMNS_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const applyMigrationTransaction = await loadRunner();
    const client = await runnerDatabase('ppbf_test_volp_rdy_ok');
    try {
      const migrationSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_volunteer_program_migration.sql'), 'utf8');
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
