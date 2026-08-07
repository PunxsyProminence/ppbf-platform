// Real PostgreSQL-backed contract test for the clearance register migration
// (pilot.clearance_types, pilot.person_clearances,
// pilot.activity_clearance_requirements, pilot.v_clearance_status) and for
// clearanceRegister.ts's functions running against a real transaction.
//
// Five things need proving, and none can be proven by reading SQL or by a
// mocked-query unit test:
//
// 1. pilot_person_clearances_current holds: status='current' requires a
//    verifier, a verified_at, and an issued_on -- all three, not any one.
// 2. v_clearance_status reports 'expired' for a clearance whose status is
//    'current' but whose expires_on has passed, and 'missing' where no
//    pilot.person_clearances row exists at all for a required clearance.
// 3. The view is genuinely read-only (no write path), matching the
//    migration's own comment on pilot.v_clearance_status.
// 4. recordPersonClearance upserts on (organization_id, person_account_id,
//    clearance_type_id) rather than accumulating history rows.
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

import { getClearanceStatus, recordPersonClearance } from './clearanceRegister';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-clearance-register-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_clearance_register_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-clearance-register-migration.mjs',
);

const ORG_A = 'org-clearance-a';
const COACH_A = 'acct-clearance-coach-a';
const VOLUNTEER_A = 'acct-clearance-volunteer-a';
const ADMIN_A = 'acct-clearance-admin-a';

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
  for (const accountId of [COACH_A, VOLUNTEER_A, ADMIN_A]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
      [accountId, ORG_A],
    );
  }

  activeClient = client;
  return client;
}

async function insertClearanceType(client: Client, opts: { clearanceTypeId: string; name: string }): Promise<void> {
  await client.query(
    `insert into pilot.clearance_types
       (organization_id, clearance_type_id, name, issuing_authority, authority_kind)
     values ($1,$2,$3,'PA Dept of Human Services','state_statutory')`,
    [ORG_A, opts.clearanceTypeId, opts.name],
  );
}

async function insertRequirement(
  client: Client,
  opts: { requirementId: string; activityScope: string; clearanceTypeId: string },
): Promise<void> {
  await client.query(
    `insert into pilot.activity_clearance_requirements
       (organization_id, requirement_id, activity_scope, clearance_type_id, requirement_kind,
        approved_by_account_id, approved_at)
     values ($1,$2,$3,$4,'required',$5,now())`,
    [ORG_A, opts.requirementId, opts.activityScope, opts.clearanceTypeId, ADMIN_A],
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

describe('clearance register migration readiness against real Postgres', () => {
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_clearance_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /CLEARANCE_REGISTER_NOT_READY/,
      );
      const table = await client.query(`select to_regclass('pilot.clearance_types') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('re-running is a no-op: no duplicate constraints', async () => {
    const client = await freshDatabase('ppbf_test_clearance_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint where conname = 'pilot_person_clearances_current'`,
      );
      expect(constraints.rows[0].n).toBe(1);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_person_clearances_current', () => {
  test('status=current without a verifier is rejected', async () => {
    const client = await freshDatabase('ppbf_test_clearance_current_check');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertClearanceType(client, { clearanceTypeId: 'ct-childabuse', name: 'PA Child Abuse History' });

      await expect(
        client.query(
          `insert into pilot.person_clearances
             (organization_id, clearance_id, person_account_id, clearance_type_id, status, issued_on)
           values ($1,gen_random_uuid(),$2,'ct-childabuse','current','2026-01-01')`,
          [ORG_A, COACH_A],
        ),
      ).rejects.toThrow(/pilot_person_clearances_current/);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('recordPersonClearance status=current with a verifier is accepted and upserts on re-call', async () => {
    const client = await freshDatabase('ppbf_test_clearance_upsert');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertClearanceType(client, { clearanceTypeId: 'ct-childabuse', name: 'PA Child Abuse History' });

      const first = await recordPersonClearance({
        organizationId: ORG_A,
        personAccountId: COACH_A,
        clearanceTypeId: 'ct-childabuse',
        status: 'current',
        issuedOn: '2026-01-01',
        expiresOn: '2027-01-01',
        verifiedByAccountId: ADMIN_A,
      });
      expect(first.status).toBe('current');
      expect(first.verified_at).not.toBeNull();

      // A second call for the same person/clearance type upserts the same
      // row rather than creating a second one.
      const second = await recordPersonClearance({
        organizationId: ORG_A,
        personAccountId: COACH_A,
        clearanceTypeId: 'ct-childabuse',
        status: 'expired',
      });
      expect(second.status).toBe('expired');

      const { rows } = await client.query(
        `select count(*)::int as n from pilot.person_clearances
         where organization_id = $1 and person_account_id = $2 and clearance_type_id = 'ct-childabuse'`,
        [ORG_A, COACH_A],
      );
      expect(rows[0].n).toBe(1);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot.v_clearance_status', () => {
  test("returns 'expired' for a current clearance past expires_on, and 'missing' where no row exists", async () => {
    const client = await freshDatabase('ppbf_test_clearance_status_view');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertClearanceType(client, { clearanceTypeId: 'ct-childabuse', name: 'PA Child Abuse History' });
      await insertRequirement(client, {
        requirementId: 'req-1', activityScope: 'supervise_sparring', clearanceTypeId: 'ct-childabuse',
      });

      // COACH_A: current, but expired.
      await recordPersonClearance({
        organizationId: ORG_A,
        personAccountId: COACH_A,
        clearanceTypeId: 'ct-childabuse',
        status: 'current',
        issuedOn: '2020-01-01',
        expiresOn: '2021-01-01',
        verifiedByAccountId: ADMIN_A,
      });
      // VOLUNTEER_A: no pilot.person_clearances row at all.

      const status = await getClearanceStatus(ORG_A, { activityScope: 'supervise_sparring' });
      const byPerson = Object.fromEntries(status.map((row) => [row.person_account_id, row.display_state]));

      expect(byPerson[COACH_A]).toBe('expired');
      expect(byPerson[VOLUNTEER_A]).toBe('missing');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('the view has no write path -- it is not updatable', async () => {
    const client = await freshDatabase('ppbf_test_clearance_view_readonly');
    try {
      await applyMigrationTransaction(client, migrationSql);

      await expect(
        client.query(`update pilot.v_clearance_status set clearance_status = 'current' where true`),
      ).rejects.toThrow();

      const { rows } = await client.query(
        `select is_updatable from information_schema.views
         where table_schema = 'pilot' and table_name = 'v_clearance_status'`,
      );
      expect(rows[0].is_updatable).toBe('NO');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
