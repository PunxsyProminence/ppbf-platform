// Real PostgreSQL-backed contract test for the attendance parent-method
// migration.
//
// The property under test: pilot.scheduler_attendance.method admits 'parent'
// after the migration and did not before, and the other three values
// ('self', 'coach_override', 'admin_override') still work on both sides of
// it -- widening the vocabulary must not narrow it by accident.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-attendance-method-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_attendance_parent_method_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-attendance-parent-method-migration.mjs',
);

// Jest's CJS transform rewrites a bare `import()` into `require()`, which
// cannot load an ESM .mjs runner. Building the import through `new Function`
// keeps a real dynamic import in the emitted code, which Node honors under
// --experimental-vm-modules (the flag every test:migrations:* script already
// passes). Same pattern as activityLog.pg.test.ts.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-attendance';
const COACH_ID = 'acct-attendance-coach';
const PARENT_ID = 'acct-attendance-parent';
const ATHLETE_ID = 'ATH-ATTENDANCE-1';
const CLASS_ID = 'class-attendance-1';

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

/** Fresh database with the base schema and the org/coach/athlete/class rows the FKs need. */
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
     values ($1, $2, 'Attendance Athlete', '2011-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  await insertClass(client, CLASS_ID);
  return client;
}

async function insertClass(client: Client, classId: string): Promise<void> {
  await client.query(
    `insert into pilot.scheduler_classes (organization_id, class_id, title, start_at, end_at, location, capacity, scheduled_by_account_id, coach_account_id, status)
     values ($1, $2, 'Fundamentals', now(), now() + interval '1 hour', 'Main Floor', 20, $3, $3, 'open')
     on conflict do nothing`,
    [ORG_ID, classId, COACH_ID],
  );
}

// (organization_id, class_id, athlete_id) is unique on scheduler_attendance,
// so testing more than one method against the same athlete requires a
// distinct class per attempt -- a real gym roster would never have the same
// athlete marked twice for one class either.
async function insertAttendance(client: Client, method: string, classId: string = CLASS_ID): Promise<void> {
  await client.query(
    `insert into pilot.scheduler_attendance
       (organization_id, attendance_id, class_id, athlete_id, status, method, checked_in_by_role, checked_in_by_account_id, note, checked_in_at)
     values ($1, $2, $3, $4, 'present', $5, 'parent', $6, '', now())`,
    [ORG_ID, `attendance-${method}-${classId}`, classId, ATHLETE_ID, method, PARENT_ID],
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

describe('attendance parent-method migration against real Postgres', () => {
  // pilot_slice_postgres.sql (the base schema this repo bootstraps fresh
  // environments from) was updated in the same change as this migration to
  // admit 'parent' directly, so a brand-new database already accepts it
  // without running the increment -- exactly like scheduler-tables shipping
  // ahead of its own increment migration. What this suite actually proves is
  // narrower and matters more: that the migration is a safe, idempotent
  // no-op against a database that already has the corrected vocabulary, AND
  // that it would have fixed an *older* database that still carried the
  // original three-value constraint. The second half is simulated below by
  // re-narrowing the constraint immediately after loading the base schema.
  async function narrowToOriginalThreeValues(client: Client): Promise<void> {
    await client.query(`
      alter table pilot.scheduler_attendance drop constraint if exists scheduler_attendance_method_check;
      alter table pilot.scheduler_attendance drop constraint if exists pilot_scheduler_attendance_method_check;
      alter table pilot.scheduler_attendance
        add constraint scheduler_attendance_method_check
        check (method in ('self', 'coach_override', 'admin_override'));
    `);
  }

  test('the gap is real: the original three-value constraint refuses parent', async () => {
    const client = await freshDatabase('ppbf_test_attmethod_absent');
    try {
      await narrowToOriginalThreeValues(client);
      await expect(insertAttendance(client, 'parent')).rejects.toThrow(/scheduler_attendance_method_check/);
    } finally {
      await client.end();
    }
  });

  test('the migration admits parent on a database that still had the original constraint', async () => {
    const client = await freshDatabase('ppbf_test_attmethod_fixed');
    try {
      await narrowToOriginalThreeValues(client);
      await client.query(migrationSql);
      await insertAttendance(client, 'parent');

      const row = await client.query(
        'select method from pilot.scheduler_attendance where attendance_id = $1',
        [`attendance-parent-${CLASS_ID}`],
      );
      expect(row.rows[0].method).toBe('parent');
    } finally {
      await client.end();
    }
  });

  test('the original three values still store after the migration', async () => {
    const client = await freshDatabase('ppbf_test_attmethod_original');
    try {
      await client.query(migrationSql);

      for (const method of ['self', 'coach_override', 'admin_override']) {
        const classId = `${CLASS_ID}-${method}`;
        await insertClass(client, classId);
        await insertAttendance(client, method, classId);
      }

      const rows = await client.query(
        `select method from pilot.scheduler_attendance where organization_id = $1 order by method`,
        [ORG_ID],
      );
      expect(rows.rows.map((r) => r.method).sort()).toEqual(['admin_override', 'coach_override', 'self']);
    } finally {
      await client.end();
    }
  });

  test('the database refuses a method outside the four-value vocabulary', async () => {
    const client = await freshDatabase('ppbf_test_attmethod_refuses');
    try {
      await client.query(migrationSql);
      await expect(insertAttendance(client, 'volunteer_override')).rejects.toThrow(
        /pilot_scheduler_attendance_method_check/,
      );
    } finally {
      await client.end();
    }
  });

  test('re-running the migration is a no-op and does not disturb stored rows', async () => {
    const client = await freshDatabase('ppbf_test_attmethod_rerun');
    try {
      await client.query(migrationSql);
      await insertAttendance(client, 'parent');

      await client.query(migrationSql);

      const row = await client.query(
        'select method from pilot.scheduler_attendance where attendance_id = $1',
        [`attendance-parent-${CLASS_ID}`],
      );
      expect(row.rows[0].method).toBe('parent');
    } finally {
      await client.end();
    }
  });
});

// The runner's OWN readiness assertion, not just the SQL it applies.
//
// Every case above applies `migrationSql` with a plain `client.query`, which
// proves the schema and proves nothing about
// scripts/pilot-apply-attendance-parent-method-migration.mjs's READINESS_QUERY -- the
// assertion that gates the dispatch, and the code whose first real execution
// is against a live environment at the most expensive possible moment. #488
// is what that costs: an assertion that could not pass on ANY database,
// found only by a staging dispatch it then blocked.
//
// The query is never restated here. `applyMigrationTransaction` is imported
// out of the shipped runner and executes the shipped READINESS_QUERY, so
// this cannot stay green while the runner rots.
describe('attendance parent method runner readiness assertion', () => {
  test('the real runner REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('attpm_rdy_no');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /ATTENDANCE_PARENT_METHOD_NOT_READY/,
      );
    } finally {
      await client.end();
    }
  });

  test('the real runner ACCEPTS a correctly migrated database, and a re-apply stays a no-op', async () => {
    const client = await freshDatabase('attpm_rdy_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      // The `all` chain re-runs every migration on every dispatch (#489), so
      // the second pass has to survive its own first pass.
      await applyMigrationTransaction(client, migrationSql);
    } finally {
      await client.end();
    }
  });
});
