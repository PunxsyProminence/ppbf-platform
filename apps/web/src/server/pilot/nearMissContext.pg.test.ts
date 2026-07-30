// Real PostgreSQL-backed test for the near-miss generation-path reader.
//
// listRecentNearMisses feeds athlete-scoped SHADOW chat context (severity
// CASE ordering, interval window arithmetic, cap) -- exactly the class of
// real-SQL statement whose only other coverage would be mocks, which is how
// the worker's claim bug shipped (#89). Rows are written through the real
// flagNearMiss writer so the audit side of the write is exercised too.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-near-miss-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_near_miss';

// Mirror of MIGRATION_FILES in scripts/pilot-apply-shadow-runtime-migration.mjs.
const SHADOW_RUNTIME_MIGRATION_FILES = [
  'pilot_slice_postgres_shadow_runtime_migration.sql',
  'pilot_slice_postgres_shadow_formula_foundation_migration.sql',
  'pilot_slice_postgres_shadow_evidence_migration.sql',
  'pilot_slice_postgres_shadow_job_lease_migration.sql',
  'pilot_slice_postgres_board_role_migration.sql',
  'pilot_slice_postgres_shadow_decision_loop_migration.sql',
  'pilot_slice_postgres_shadow_chunk_embedding_migration.sql',
];

const ORG_ID = 'org-near-miss';
const COACH_ID = 'acct-near-miss-coach';
const ATHLETE_ID = 'ATH-NM-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let nearMisses: typeof import('./shadowNearMisses');
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
  for (const file of SHADOW_RUNTIME_MIGRATION_FILES) {
    await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }
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
     values ($1, $2, 'Near Miss Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  db = await import('./db');
  nearMisses = await import('./shadowNearMisses');
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

describe('listRecentNearMisses against the real schema', () => {
  test('orders severity first, honors the window, and caps the list', async () => {
    const flag = (description: string, severity: 'low' | 'moderate' | 'high' | 'critical') =>
      nearMisses.flagNearMiss({
        organizationId: ORG_ID,
        athleteId: ATHLETE_ID,
        description,
        severity,
        detectedByAccountId: COACH_ID,
        detectedByRole: 'coach',
      });

    const stale = await flag('Old critical event, outside the window', 'critical');
    // Backdate it beyond the 90-day window: recency is data, not insert order.
    await db.query(
      `update pilot.shadow_near_misses set created_at = now() - interval '120 days' where near_miss_id = $1`,
      [stale.near_miss_id],
    );
    const low = await flag('Minor slip on wet floor near the bags', 'low');
    const critical = await flag('Athlete continued after a hard head contact', 'critical');
    const moderate = await flag('Sparring intensity above the agreed plan', 'moderate');

    const recent = await nearMisses.listRecentNearMisses(ORG_ID, ATHLETE_ID);
    // Severity outranks recency (the low event is the newest write after the
    // critical one? insert order low -> critical -> moderate; critical must
    // still lead), and the backdated critical is excluded by the window.
    expect(recent.map((row) => row.near_miss_id)).toEqual([
      critical.near_miss_id,
      moderate.near_miss_id,
      low.near_miss_id,
    ]);

    const capped = await nearMisses.listRecentNearMisses(ORG_ID, ATHLETE_ID, { limit: 2 });
    expect(capped.map((row) => row.severity)).toEqual(['critical', 'moderate']);

    const widened = await nearMisses.listRecentNearMisses(ORG_ID, ATHLETE_ID, { windowDays: 365 });
    expect(widened.some((row) => row.near_miss_id === stale.near_miss_id)).toBe(true);
  });
});
