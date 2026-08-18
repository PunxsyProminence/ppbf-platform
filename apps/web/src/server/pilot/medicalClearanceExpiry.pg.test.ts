// Real PostgreSQL-backed test for the medical-clearance expiry migration.
//
// The whole point of expires_at is that a gate can trust what it reads, so the
// DDL and the round trip need real SQL rather than mocks: an ALTER that does not
// apply, a CHECK that does not bite, or a `expires_at::text` cast that comes
// back as a Date instead of a string would all pass the unit suites and fail
// against a database. That is the class of defect this file exists to catch.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-medical-clearance-expiry-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_medical_clearance_expiry';

// Mirror of MIGRATION_FILES in scripts/pilot-apply-shadow-runtime-migration.mjs,
// plus the migration under test. The expiry migration MUST come after
// shadow-decision-loop, which creates the table it alters -- the same ordering
// the apply-migrations workflow's `all` list encodes.
const MIGRATION_FILES = [
  'pilot_slice_postgres_shadow_runtime_migration.sql',
  'pilot_slice_postgres_shadow_formula_foundation_migration.sql',
  'pilot_slice_postgres_shadow_evidence_migration.sql',
  'pilot_slice_postgres_shadow_job_lease_migration.sql',
  'pilot_slice_postgres_board_role_migration.sql',
  'pilot_slice_postgres_shadow_decision_loop_migration.sql',
  'pilot_slice_postgres_medical_clearance_expiry_migration.sql',
];

const EXPIRY_MIGRATION = 'pilot_slice_postgres_medical_clearance_expiry_migration.sql';

const ORG_ID = 'org-clearance-expiry';
const COACH_ID = 'acct-clearance-coach';
const ATHLETE_ID = 'ATH-CE-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let medical: typeof import('./shadowMedicalStatus');
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
  for (const file of MIGRATION_FILES) {
    await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }
  // Applied twice on purpose. Every migration in this repository is re-run
  // wholesale by the `all` path, so a guarded-constraint block that raises on a
  // second pass would break every future rebuild.
  await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, EXPIRY_MIGRATION), 'utf8'));

  await migrateClient.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await migrateClient.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH_ID, ORG_ID],
  );
  // pilot.athletes declares created_at/updated_at NOT NULL with no defaults.
  await migrateClient.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Clearance Expiry Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  db = await import('./db');
  medical = await import('./shadowMedicalStatus');
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

describe('the expiry column as the migration actually leaves it', () => {
  test('expires_at exists, is timestamptz, and is NULLABLE', async () => {
    const rows = await db.query<{ data_type: string; is_nullable: string; column_default: string | null }>(
      `select data_type, is_nullable, column_default
       from information_schema.columns
       where table_schema = 'pilot'
         and table_name = 'shadow_medical_administrative_status'
         and column_name = 'expires_at'`,
      [],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('timestamp with time zone');
    // Nullable and default-free is an assertion, not an accident: a NOT NULL
    // column with a default would mean this migration had picked a clinical
    // validity window for every child on the roster, which is the one decision
    // it refuses to make (docs/HANDOFF_RESEARCH.md item 1).
    expect(rows[0].is_nullable).toBe('YES');
    expect(rows[0].column_default).toBeNull();
  });

  test('an expiry at or before the moment the record took effect is rejected by the database', async () => {
    await expect(db.query(
      `insert into pilot.shadow_medical_administrative_status
         (organization_id, athlete_id, status, set_by_account_id, set_by_role, effective_at, expires_at)
       values ($1, $2, 'cleared', $3, 'coach', now(), now() - interval '1 day')`,
      [ORG_ID, ATHLETE_ID, COACH_ID],
    )).rejects.toThrow(/shadow_medical_status_expires_after_effective_check/);
  });

  test('an expiry after the effective moment is accepted', async () => {
    await expect(db.query(
      `insert into pilot.shadow_medical_administrative_status
         (organization_id, athlete_id, status, set_by_account_id, set_by_role, effective_at, expires_at)
       values ($1, $2, 'pending', $3, 'coach', now(), now() + interval '1 day')`,
      [ORG_ID, ATHLETE_ID, COACH_ID],
    )).resolves.toBeDefined();
  });
});

describe('the write and read path against real SQL', () => {
  test('an explicit expiry survives the round trip as a string, and is honoured', async () => {
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const written = await medical.setMedicalAdministrativeStatus({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      status: 'cleared',
      sourceReference: 'physician-note-real-sql',
      expiresAt,
      setByAccountId: COACH_ID,
      setByRole: 'coach',
    });

    // The ::text cast matters: a Date would make isClearanceCurrent's
    // new Date(row.expires_at) work by luck and the typing a lie.
    expect(typeof written.expires_at).toBe('string');

    const read = await medical.getLatestMedicalAdministrativeStatus(ORG_ID, ATHLETE_ID);
    expect(typeof read?.expires_at).toBe('string');
    expect(medical.isClearanceCurrent(read)).toBe(true);
    expect(medical.effectiveMedicalStatus(read)).toBe('cleared');
  });

  test('once the stored expiry has passed, the same row stops reading as cleared', async () => {
    const written = await medical.setMedicalAdministrativeStatus({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      status: 'cleared',
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      setByAccountId: COACH_ID,
      setByRole: 'coach',
    });

    // Age the record in the database rather than faking a clock: this is the
    // real shape of the finding -- a clearance recorded once, still the latest
    // row, months later. Earlier rows written by the tests above are removed so
    // this one genuinely IS the latest after being backdated, which is the
    // condition the gates read under.
    await db.query(
      `delete from pilot.shadow_medical_administrative_status
       where organization_id = $1 and athlete_id = $2 and status_id <> $3`,
      [ORG_ID, ATHLETE_ID, written.status_id],
    );
    await db.query(
      `update pilot.shadow_medical_administrative_status
       set effective_at = now() - interval '400 days', expires_at = now() - interval '35 days'
       where status_id = $1`,
      [written.status_id],
    );

    const read = await medical.getLatestMedicalAdministrativeStatus(ORG_ID, ATHLETE_ID);
    expect(read?.status).toBe('cleared');
    expect(medical.isClearanceCurrent(read)).toBe(false);
    expect(medical.effectiveMedicalStatus(read)).toBe(medical.EXPIRED_CLEARANCE_STATUS);
  });

  test('a record written with no expiry still reads as current -- existing behaviour is unchanged', async () => {
    const written = await medical.setMedicalAdministrativeStatus({
      organizationId: ORG_ID,
      athleteId: ATHLETE_ID,
      status: 'cleared',
      setByAccountId: COACH_ID,
      setByRole: 'coach',
    });

    expect(written.expires_at).toBeNull();

    const read = await medical.getLatestMedicalAdministrativeStatus(ORG_ID, ATHLETE_ID);
    expect(read?.expires_at).toBeNull();
    expect(medical.isClearanceCurrent(read)).toBe(true);
  });
});
