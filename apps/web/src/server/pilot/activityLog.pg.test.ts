// Real PostgreSQL-backed contract test for the activity log migration
// (pilot.activity_log) and for activityLog.ts's functions running against a
// real transaction.
//
// pilot.sparring_rounds previously lived in this migration and this test
// file; both were removed before ever shipping to a database, superseded by
// pilot.sparring_exposure (sparringExposure.ts / sparringExposure.pg.test.ts).
//
// Four things need proving, and none can be proven by reading SQL or by a
// mocked-query unit test:
//
// 1. A duplicate (person, date, domain, class) occurrence is rejected,
//    INCLUDING the open-gym case where class_id is null on both attempts --
//    proving the coalesce-to-sentinel in pilot_activity_log_one_per_occurrence
//    actually closes the null-defeats-uniqueness hole pilot.attendance had.
// 2. A community_service row with no verifier is rejected;
//    a boxing_training row with no verifier is accepted -- proving
//    pilot_activity_log_verified_check is domain-scoped, not blanket.
// 3. recordActivity translates the raw constraint violation into
//    ACTIVITY_LOG_DUPLICATE_OCCURRENCE and ACTIVITY_LOG_VERIFIER_REQUIRED,
//    not a raw Postgres error.
// 4. The readiness check actually fails when the migration did not land.
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

import { recordActivity } from './activityLog';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-activity-log-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_activity_log_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-activity-log-migration.mjs',
);

const ORG_A = 'org-activitylog-a';
const ATHLETE_A = 'athlete-activitylog-a';
const COACH_A = 'acct-activitylog-coach-a';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let migrationSql: string;
let baseSchemaSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;

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
    [ORG_A],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_A, ORG_A],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'athlete', $2, 'microsoft') on conflict do nothing`,
    [ATHLETE_A, ORG_A],
  );
  await client.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag,
        coach_id, created_at, updated_at)
     values ($1,$2,'Athlete A','2010-01-01','120lb','active','Contact',true,$3,now(),now())
     on conflict do nothing`,
    [ORG_A, ATHLETE_A, COACH_A],
  );

  activeClient = client;
  return client;
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

describe('activity log migration readiness against real Postgres', () => {
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_actlog_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /ACTIVITY_LOG_NOT_READY/,
      );
      const table = await client.query(`select to_regclass('pilot.activity_log') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('re-running is a no-op: no duplicate constraints or indexes', async () => {
    const client = await freshDatabase('ppbf_test_actlog_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint
         where conname in ('pilot_activity_log_domain_check', 'pilot_activity_log_verified_check')`,
      );
      expect(constraints.rows[0].n).toBe(2);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_activity_log_one_per_occurrence', () => {
  test('rejects a duplicate (person, date, domain, class) occurrence', async () => {
    const client = await freshDatabase('ppbf_test_actlog_dup_class');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await recordActivity({
        organizationId: ORG_A,
        personAccountId: ATHLETE_A,
        athleteId: ATHLETE_A,
        activityDomain: 'boxing_training',
        activityType: 'technical_session',
        occurredOn: '2026-08-01',
        durationMinutes: 60,
        classId: 'class-1',
        captureMethod: 'door_terminal',
        recordedByRole: 'coach',
        recordedByAccountId: COACH_A,
      });

      await expect(
        recordActivity({
          organizationId: ORG_A,
          personAccountId: ATHLETE_A,
          athleteId: ATHLETE_A,
          activityDomain: 'boxing_training',
          activityType: 'technical_session',
          occurredOn: '2026-08-01',
          durationMinutes: 45,
          classId: 'class-1',
          captureMethod: 'coach_override',
          recordedByRole: 'coach',
          recordedByAccountId: COACH_A,
        }),
      ).rejects.toThrow('ACTIVITY_LOG_DUPLICATE_OCCURRENCE');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  // The hole pilot.attendance had: unlimited nulls defeating uniqueness.
  // coalesce(class_id, '__none__') is what pilot_activity_log_one_per_occurrence
  // uses to close it -- proven here with two open-gym rows, both class_id
  // null, same person/date/domain/start time.
  test('rejects a duplicate open-gym occurrence where class_id is null on both', async () => {
    const client = await freshDatabase('ppbf_test_actlog_dup_open_gym');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await recordActivity({
        organizationId: ORG_A,
        personAccountId: ATHLETE_A,
        athleteId: ATHLETE_A,
        activityDomain: 'boxing_training',
        activityType: 'open_gym',
        occurredOn: '2026-08-01',
        durationMinutes: 60,
        classId: null,
        captureMethod: 'self',
        recordedByRole: 'athlete',
        recordedByAccountId: ATHLETE_A,
      });

      await expect(
        recordActivity({
          organizationId: ORG_A,
          personAccountId: ATHLETE_A,
          athleteId: ATHLETE_A,
          activityDomain: 'boxing_training',
          activityType: 'open_gym',
          occurredOn: '2026-08-01',
          durationMinutes: 30,
          classId: null,
          captureMethod: 'self',
          recordedByRole: 'athlete',
          recordedByAccountId: ATHLETE_A,
        }),
      ).rejects.toThrow('ACTIVITY_LOG_DUPLICATE_OCCURRENCE');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_activity_log_verified_check', () => {
  test('a community_service row without a verifier is rejected', async () => {
    const client = await freshDatabase('ppbf_test_actlog_verifier_required');
    try {
      await applyMigrationTransaction(client, migrationSql);

      await expect(
        recordActivity({
          organizationId: ORG_A,
          personAccountId: ATHLETE_A,
          athleteId: ATHLETE_A,
          activityDomain: 'community_service',
          activityType: 'court_ordered',
          occurredOn: '2026-08-01',
          durationMinutes: 120,
          captureMethod: 'supervisor_entry',
          recordedByRole: 'coach',
          recordedByAccountId: COACH_A,
        }),
      ).rejects.toThrow('ACTIVITY_LOG_VERIFIER_REQUIRED');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a boxing_training row without a verifier is accepted', async () => {
    const client = await freshDatabase('ppbf_test_actlog_no_verifier_needed');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const row = await recordActivity({
        organizationId: ORG_A,
        personAccountId: ATHLETE_A,
        athleteId: ATHLETE_A,
        activityDomain: 'boxing_training',
        activityType: 'technical_session',
        occurredOn: '2026-08-01',
        durationMinutes: 60,
        captureMethod: 'door_terminal',
        recordedByRole: 'coach',
        recordedByAccountId: COACH_A,
      });
      expect(row.verified_by_account_id).toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a community_service row WITH a verifier is accepted', async () => {
    const client = await freshDatabase('ppbf_test_actlog_verifier_given');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const row = await recordActivity({
        organizationId: ORG_A,
        personAccountId: ATHLETE_A,
        athleteId: ATHLETE_A,
        activityDomain: 'community_service',
        activityType: 'court_ordered',
        occurredOn: '2026-08-01',
        durationMinutes: 120,
        captureMethod: 'supervisor_entry',
        recordedByRole: 'coach',
        recordedByAccountId: COACH_A,
        verifiedByAccountId: COACH_A,
      });
      expect(row.verified_by_account_id).toBe(COACH_A);
      expect(row.verified_at).not.toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

