// Real PostgreSQL-backed contract test for the scheduler coaching-request
// withdrawn migration (parent walk 2026-10-19 item 9; Jason 2026-10-19, Q4
// "A: Family can withdraw (Rec.)").
//
// The property under test: pilot.scheduler_coaching_requests.status admits
// 'withdrawn' after the migration and did not before, the three earlier
// values still store, the migration re-applies as a no-op, and the shipped
// withdraw statement moves only a PENDING request -- an approval or decline
// committed first is not overwritten.
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

import { COACHING_REQUEST_WITHDRAW_SQL } from './schedulerDb';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-coaching-withdrawn-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_scheduler_coaching_request_withdrawn_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-scheduler-coaching-request-withdrawn-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-withdrawn';
const COACH_ID = 'acct-withdrawn-coach';
const PARENT_ID = 'acct-withdrawn-parent';
const ATHLETE_ID = 'ATH-WITHDRAWN-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;
let baseSchemaSql: string;

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

/** Fresh database with the base schema and the org/parent/athlete rows the FKs need. */
async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'parent', $2, 'microsoft') on conflict do nothing`,
    [PARENT_ID, ORG_ID],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Request Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  return client;
}

async function insertRequest(client: Client, requestId: string, status: string): Promise<void> {
  await client.query(
    `insert into pilot.scheduler_coaching_requests
       (organization_id, request_id, athlete_id, requested_by_role, requested_by_account_id, preferred_at, goals, status)
     values ($1, $2, $3, 'parent', $4, '2026-08-12T17:00:00Z', 'Footwork', $5)`,
    [ORG_ID, requestId, ATHLETE_ID, PARENT_ID, status],
  );
}

async function statusOf(client: Client, requestId: string): Promise<string> {
  const row = await client.query(
    'select status from pilot.scheduler_coaching_requests where organization_id = $1 and request_id = $2',
    [ORG_ID, requestId],
  );
  return row.rows[0].status;
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
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

describe('coaching-request withdrawn migration against real Postgres', () => {
  const EARLIER_VALUES = ['pending', 'approved', 'declined'];

  test('the gap is real: the base schema refuses withdrawn before the migration', async () => {
    const client = await freshDatabase('ppbf_test_cr_wd_absent');
    try {
      await expect(insertRequest(client, 'req-1', 'withdrawn')).rejects.toThrow(/scheduler_coaching_requests_status_check/);
    } finally {
      await client.end();
    }
  });

  test('the migration admits withdrawn, and the three earlier values still store', async () => {
    const client = await freshDatabase('ppbf_test_cr_wd_fixed');
    try {
      await client.query(migrationSql);
      await insertRequest(client, 'req-withdrawn', 'withdrawn');
      for (const status of EARLIER_VALUES) {
        await insertRequest(client, `req-${status}`, status);
      }
      expect(await statusOf(client, 'req-withdrawn')).toBe('withdrawn');
      for (const status of EARLIER_VALUES) {
        expect(await statusOf(client, `req-${status}`)).toBe(status);
      }
    } finally {
      await client.end();
    }
  });

  test('the database still refuses a status outside the four-value vocabulary', async () => {
    const client = await freshDatabase('ppbf_test_cr_wd_refuses');
    try {
      await client.query(migrationSql);
      await expect(insertRequest(client, 'req-1', 'cancelled')).rejects.toThrow(
        /pilot_scheduler_coaching_requests_status_check/,
      );
    } finally {
      await client.end();
    }
  });

  test('re-running the migration is a no-op and does not disturb stored rows', async () => {
    const client = await freshDatabase('ppbf_test_cr_wd_rerun');
    try {
      await client.query(migrationSql);
      await insertRequest(client, 'req-1', 'withdrawn');
      await client.query(migrationSql);
      expect(await statusOf(client, 'req-1')).toBe('withdrawn');
    } finally {
      await client.end();
    }
  });
});

describe('the shipped withdraw statement', () => {
  test('moves a pending request to withdrawn, and only a pending one', async () => {
    const client = await freshDatabase('ppbf_test_cr_wd_cas');
    try {
      await client.query(migrationSql);
      await insertRequest(client, 'req-pending', 'pending');
      await insertRequest(client, 'req-approved', 'approved');
      await insertRequest(client, 'req-declined', 'declined');

      const at = '2026-10-19T20:00:00.000Z';
      const pending = await client.query(COACHING_REQUEST_WITHDRAW_SQL, [ORG_ID, 'req-pending', at]);
      expect(pending.rows).toEqual([{ request_id: 'req-pending' }]);
      expect(await statusOf(client, 'req-pending')).toBe('withdrawn');

      // An answer committed first is not overwritten; a second withdraw is a miss.
      for (const id of ['req-approved', 'req-declined', 'req-pending']) {
        const miss = await client.query(COACHING_REQUEST_WITHDRAW_SQL, [ORG_ID, id, at]);
        expect(miss.rows).toEqual([]);
      }
      expect(await statusOf(client, 'req-approved')).toBe('approved');
      expect(await statusOf(client, 'req-declined')).toBe('declined');

      // Another organization's id matches nothing.
      const other = await client.query(COACHING_REQUEST_WITHDRAW_SQL, ['org-other', 'req-approved', at]);
      expect(other.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, imported out of the shipped runner,
// so this cannot stay green while the runner rots (same reasoning as
// attendanceWalkInMethod.pg.test.ts).
describe('coaching-request withdrawn runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('crwd_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /SCHEDULER_COACHING_REQUEST_WITHDRAWN_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('crwd_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
