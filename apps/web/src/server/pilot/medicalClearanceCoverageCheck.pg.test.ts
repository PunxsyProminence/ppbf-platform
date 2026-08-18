// Real PostgreSQL-backed test for pilot-check-medical-clearance-coverage.mjs.
//
// Spins up a disposable, local-only embedded Postgres instance (see
// scripts/test-embedded-pg-server.mjs). This NEVER connects to production or
// staging.
//
// What this pins down: assertMedicalStatusAllowsRecommendation now runs
// unconditionally, and only an athlete whose LATEST status row is exactly
// 'cleared' passes it. This check has to answer "how many athletes are in
// that state" against a real roster -- so the test seeds a full spread
// (no record, pending, restricted, not_cleared, cleared, a superseded-then-
// re-cleared history, an inactive athlete, and a second organization) and
// asserts the per-org counts match what getLatestMedicalAdministrativeStatus
// would actually decide for each one.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import fs from 'node:fs/promises';

import { Client } from 'pg';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-medical-clearance-coverage-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CHECKER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/pilot-check-medical-clearance-coverage.mjs');
const SCHEMA_SQL_PATH = path.resolve(__dirname, '../../../../../infra/azure/pilot_slice_postgres.sql');
const DECISION_LOOP_SQL_PATH = path.resolve(
  __dirname,
  '../../../../../infra/azure/pilot_slice_postgres_shadow_decision_loop_migration.sql',
);

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;

interface CoverageRow {
  organization_id: string;
  active_athletes: number;
  cleared: number;
  restricted: number;
  not_cleared: number;
  pending: number;
  no_record: number;
}

// A plain `await import(specifier)` gets downleveled by ts-jest's CommonJS
// transform into require(), which cannot load a real ESM-only .mjs file.
// Constructing the import() call inside `new Function` hides it from that
// downleveling, so it remains a genuine dynamic import Node's own ESM loader
// executes at runtime -- the same technique strandedGuardianCheck.pg.test.ts
// uses for the same reason.
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<{
  checkMedicalClearanceCoverage: (client: Client) => Promise<{ byOrg: CoverageRow[] }>;
}>;

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

async function newTestDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  return client;
}

async function insertOrg(client: Client, organizationId: string) {
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status, created_at, updated_at)
     values ($1, $1, 'active', now(), now())`,
    [organizationId],
  );
}

async function insertCoach(client: Client, organizationId: string, coachId: string) {
  await client.query(
    `insert into pilot.accounts (account_id, login_email, auth_provider, role, organization_id, is_platform_owner, athlete_id, pin_hash, active_flag)
     values ($1, $1 || '@example.com', 'microsoft', 'coach', $2, false, null, null, true)`,
    [coachId, organizationId],
  );
}

async function insertAthlete(
  client: Client,
  organizationId: string,
  athleteId: string,
  coachId: string,
  activeFlag = true,
) {
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, $2, '2012-01-01', 'bantam', 'active', 'contact', $3, $4, now(), now())`,
    [organizationId, athleteId, activeFlag, coachId],
  );
}

async function insertStatus(
  client: Client,
  organizationId: string,
  athleteId: string,
  status: string,
  coachId: string,
  effectiveAt: string,
) {
  await client.query(
    `insert into pilot.shadow_medical_administrative_status
       (organization_id, athlete_id, status, restriction_flags, source_reference, set_by_account_id, set_by_role, effective_at)
     values ($1, $2, $3, '{}'::jsonb, null, $4, 'coach', $5)`,
    [organizationId, athleteId, status, coachId, effectiveAt],
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

describe('checkMedicalClearanceCoverage', () => {
  let client: Client;
  const ORG = 'gym-1';
  const ORG_2 = 'gym-2';

  beforeAll(async () => {
    client = await newTestDatabase('ppbf_test_medical_clearance_coverage');
    await client.query(await fs.readFile(SCHEMA_SQL_PATH, 'utf8'));
    await client.query(await fs.readFile(DECISION_LOOP_SQL_PATH, 'utf8'));

    await insertOrg(client, ORG);
    await insertOrg(client, ORG_2);
    await insertCoach(client, ORG, 'coach-1');
    await insertCoach(client, ORG_2, 'coach-2');

    // gym-1: one of each state, plus an inactive athlete that must not count.
    await insertAthlete(client, ORG, 'ath-no-record', 'coach-1');
    await insertAthlete(client, ORG, 'ath-pending', 'coach-1');
    await insertStatus(client, ORG, 'ath-pending', 'pending', 'coach-1', '2026-08-01T00:00:00Z');
    await insertAthlete(client, ORG, 'ath-restricted', 'coach-1');
    await insertStatus(client, ORG, 'ath-restricted', 'restricted', 'coach-1', '2026-08-01T00:00:00Z');
    await insertAthlete(client, ORG, 'ath-not-cleared', 'coach-1');
    await insertStatus(client, ORG, 'ath-not-cleared', 'not_cleared', 'coach-1', '2026-08-01T00:00:00Z');
    await insertAthlete(client, ORG, 'ath-cleared', 'coach-1');
    await insertStatus(client, ORG, 'ath-cleared', 'cleared', 'coach-1', '2026-08-01T00:00:00Z');
    // History matters: an earlier 'cleared' superseded by a later 'restricted'
    // must count as restricted, not cleared -- exactly what
    // getLatestMedicalAdministrativeStatus's own ordering would return.
    await insertAthlete(client, ORG, 'ath-superseded', 'coach-1');
    await insertStatus(client, ORG, 'ath-superseded', 'cleared', 'coach-1', '2026-07-01T00:00:00Z');
    await insertStatus(client, ORG, 'ath-superseded', 'restricted', 'coach-1', '2026-08-01T00:00:00Z');
    // Inactive: must be excluded from every count, cleared or not.
    await insertAthlete(client, ORG, 'ath-inactive', 'coach-1', false);

    // gym-2: fully covered, to prove one gym's gap does not leak into another's totals.
    await insertAthlete(client, ORG_2, 'ath2-cleared', 'coach-2');
    await insertStatus(client, ORG_2, 'ath2-cleared', 'cleared', 'coach-2', '2026-08-01T00:00:00Z');
  });

  afterAll(async () => {
    await client.end();
  });

  test('counts each active athlete under its latest status, per organization', async () => {
    const { checkMedicalClearanceCoverage } = await nativeDynamicImport(CHECKER_SCRIPT_PATH);
    const { byOrg } = await checkMedicalClearanceCoverage(client);

    const gym1 = byOrg.find((r) => r.organization_id === ORG);
    expect(gym1).toEqual({
      organization_id: ORG,
      active_athletes: 6,
      cleared: 1,
      restricted: 2,
      not_cleared: 1,
      pending: 1,
      no_record: 1,
    });

    const gym2 = byOrg.find((r) => r.organization_id === ORG_2);
    expect(gym2).toEqual({
      organization_id: ORG_2,
      active_athletes: 1,
      cleared: 1,
      restricted: 0,
      not_cleared: 0,
      pending: 0,
      no_record: 0,
    });
  });

  test('an inactive athlete is excluded from every column, even an uncovered one', async () => {
    const { checkMedicalClearanceCoverage } = await nativeDynamicImport(CHECKER_SCRIPT_PATH);
    const { byOrg } = await checkMedicalClearanceCoverage(client);

    const gym1 = byOrg.find((r) => r.organization_id === ORG);
    const counted = gym1
      ? gym1.cleared + gym1.restricted + gym1.not_cleared + gym1.pending + gym1.no_record
      : 0;
    expect(counted).toBe(gym1?.active_athletes);
    expect(counted).toBe(6); // ath-inactive is the 7th athlete and is not among these 6.
  });
});
