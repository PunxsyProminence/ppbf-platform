// Real PostgreSQL-backed contract test for the floor hours ledger migration
// (pilot.activity_log_adjustments, pilot.v_activity_effective_minutes,
// pilot.v_floor_hours_public, pilot.v_floor_hours_admin) and for
// floorHours.ts's functions running against a real transaction.
//
// Five things need proving, and none can be proven by reading SQL or by a
// mocked-query unit test:
//
// 1. pilot_activity_adj_reason actually holds: an adjustment with a reason
//    under 10 characters is rejected.
// 2. pilot.v_floor_hours_public exposes NO column that identifies a
//    person -- asserted directly against information_schema.columns, not
//    just against the TypeScript row type.
// 3. An adjustment is additive, not a rewrite: v_activity_effective_minutes
//    reflects recorded + adjustment, and the ORIGINAL activity_log row is
//    untouched.
// 4. v_floor_hours_admin carries the same total as v_floor_hours_public
//    for the same organization/domain -- the two views must agree, since
//    both read through the same effective-minutes view.
// 5. The readiness check actually fails when the migration did not land.
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

import { getFloorHoursAdmin, getFloorHoursPublic, recordActivityAdjustment } from './floorHours';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-floor-hours-ledger-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const ACTIVITY_LOG_MIGRATION_FILE = 'pilot_slice_postgres_activity_log_migration.sql';
const MIGRATION_FILE = 'pilot_slice_postgres_floor_hours_ledger_migration.sql';
const ACTIVITY_LOG_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-activity-log-migration.mjs',
);
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-floor-hours-ledger-migration.mjs',
);

const ORG_A = 'org-floorhours-a';
const ATHLETE_A = 'athlete-floorhours-a';
const COACH_A = 'acct-floorhours-coach-a';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let activityLogMigrationSql: string;
let migrationSql: string;
let baseSchemaSql: string;
let applyActivityLogMigrationTransaction: (client: Client, sql: string) => Promise<void>;
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
  await applyActivityLogMigrationTransaction(client, activityLogMigrationSql);

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

async function insertActivity(
  client: Client,
  activityId: string,
  durationMinutes: number,
  occurredOn = '2026-08-01',
): Promise<void> {
  await client.query(
    `insert into pilot.activity_log
       (organization_id, activity_id, person_account_id, athlete_id, activity_domain, activity_type,
        occurred_on, duration_minutes, capture_method, recorded_by_role, recorded_by_account_id)
     values ($1,$2,$3,$4,'boxing_training','technical_session',$5,$6,'door_terminal','coach',$7)`,
    [ORG_A, activityId, ATHLETE_A, ATHLETE_A, occurredOn, durationMinutes, COACH_A],
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
  activityLogMigrationSql = await fs.readFile(path.join(INFRA_DIR, ACTIVITY_LOG_MIGRATION_FILE), 'utf8');
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const activityLogRunnerModule = await nativeDynamicImport(pathToFileURL(ACTIVITY_LOG_RUNNER_PATH).href);
  applyActivityLogMigrationTransaction = activityLogRunnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;

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

describe('floor hours ledger migration readiness against real Postgres', () => {
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_floorhours_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /FLOOR_HOURS_LEDGER_NOT_READY/,
      );
      const table = await client.query(`select to_regclass('pilot.activity_log_adjustments') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('re-running is a no-op: no duplicate constraints', async () => {
    const client = await freshDatabase('ppbf_test_floorhours_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint where conname = 'pilot_activity_adj_reason'`,
      );
      expect(constraints.rows[0].n).toBe(1);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_activity_adj_reason', () => {
  test('an adjustment with a reason under 10 characters is rejected', async () => {
    const client = await freshDatabase('ppbf_test_floorhours_reason_too_short');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertActivity(client, 'activity-1', 60);

      await expect(
        recordActivityAdjustment({
          organizationId: ORG_A,
          activityId: 'activity-1',
          deltaMinutes: -10,
          reason: 'typo',
          adjustedByAccountId: COACH_A,
          adjustedByRole: 'coach',
        }),
      ).rejects.toThrow('ACTIVITY_ADJUSTMENT_REASON_TOO_SHORT');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('an adjustment with a real reason is accepted', async () => {
    const client = await freshDatabase('ppbf_test_floorhours_reason_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertActivity(client, 'activity-1', 60);

      const adjustment = await recordActivityAdjustment({
        organizationId: ORG_A,
        activityId: 'activity-1',
        deltaMinutes: -15,
        reason: 'Coach mistyped duration, corrected from the class roster.',
        adjustedByAccountId: COACH_A,
        adjustedByRole: 'coach',
      });
      expect(adjustment.delta_minutes).toBe(-15);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot.v_floor_hours_public exposes no person-identifying column', () => {
  test('information_schema.columns confirms no person_account_id or athlete_id column', async () => {
    const client = await freshDatabase('ppbf_test_floorhours_public_no_pii');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const { rows } = await client.query(
        `select column_name from information_schema.columns
         where table_schema = 'pilot' and table_name = 'v_floor_hours_public'`,
      );
      const columns = rows.map((row: { column_name: string }) => row.column_name);
      expect(columns).not.toContain('person_account_id');
      expect(columns).not.toContain('athlete_id');
      expect(columns).toContain('organization_id');
      expect(columns).toContain('activity_domain');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('adjustments are additive, and the original row is untouched', () => {
  test('v_activity_effective_minutes reflects recorded + adjustment', async () => {
    const client = await freshDatabase('ppbf_test_floorhours_effective_minutes');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertActivity(client, 'activity-1', 60);
      await recordActivityAdjustment({
        organizationId: ORG_A,
        activityId: 'activity-1',
        deltaMinutes: -20,
        reason: 'Coach mistyped duration, corrected from the class roster.',
        adjustedByAccountId: COACH_A,
        adjustedByRole: 'coach',
      });

      const { rows } = await client.query(
        `select recorded_minutes, adjustment_minutes, effective_minutes
         from pilot.v_activity_effective_minutes
         where organization_id = $1 and activity_id = $2`,
        [ORG_A, 'activity-1'],
      );
      expect(rows[0]).toEqual({ recorded_minutes: 60, adjustment_minutes: -20, effective_minutes: 40 });

      const original = await client.query(
        `select duration_minutes from pilot.activity_log where organization_id = $1 and activity_id = $2`,
        [ORG_A, 'activity-1'],
      );
      expect(original.rows[0].duration_minutes).toBe(60);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('public and admin views agree', () => {
  test('v_floor_hours_public and v_floor_hours_admin report the same total hours', async () => {
    const client = await freshDatabase('ppbf_test_floorhours_views_agree');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertActivity(client, 'activity-1', 60, '2026-08-01');
      await insertActivity(client, 'activity-2', 90, '2026-08-02');

      const publicRows = await getFloorHoursPublic(ORG_A, { periodKind: 'all_time' });
      const adminRows = await getFloorHoursAdmin(ORG_A);

      const publicTotal = publicRows
        .filter((row) => row.activity_domain === 'boxing_training')
        .reduce((sum, row) => sum + Number(row.hours), 0);
      const adminTotal = adminRows
        .filter((row) => row.activity_domain === 'boxing_training')
        .reduce((sum, row) => sum + Number(row.hours), 0);

      expect(publicTotal).toBeCloseTo(2.5, 2);
      expect(adminTotal).toBeCloseTo(2.5, 2);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
