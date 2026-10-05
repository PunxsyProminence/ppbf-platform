// Real PostgreSQL proof for the Coach Intelligence digest (F-002).
//
// Production answered GET /api/pilot/coach/intelligence with a 500 for every
// coach and organization_admin (docs/PRODUCTION_AUDIT_2026-10-04_USER_UI.md,
// F-002). The unit suites mock `query`, so none of the digest's SQL had ever
// been planned by Postgres. This suite runs getCoachIntelligence against the
// migrated schema with one athlete in scope, which is all it takes to reach
// every statement in the digest.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-coach-intelligence-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_coach_intelligence';

// Base schema plus the migrations that create or reshape the tables the
// digest reads.
const MIGRATION_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_video_sessions_migration.sql',
  'pilot_slice_postgres_progression_migration.sql',
  'pilot_slice_postgres_training_holds_migration.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_safety_escalations_migration.sql',
  'pilot_slice_postgres_compliance_migration.sql',
  'pilot_slice_postgres_activity_log_migration.sql',
  'pilot_slice_postgres_readiness_provenance_migration.sql',
  'pilot_slice_postgres_session_rpe_semantics_migration.sql',
  'pilot_slice_postgres_session_duration_migration.sql',
];

const ORG_ID = 'org-coach-intel';
const COACH_ID = 'acct-coach-intel-coach';
const ATHLETE_ID = 'ATH-CI-1';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let intelligence: typeof import('./coachIntelligence');

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
  for (const file of MIGRATION_FILES) {
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
     values ($1, $2, 'Coach Intel Athlete', '2012-03-04', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_ID],
  );
  // A completed session ten days old with no coach review: item 4's row.
  await migrateClient.query(
    `insert into pilot.sessions (organization_id, session_id, athlete_id, date, rpe, rpe_method, notes, completed_flag, created_at, updated_at)
     values ($1, 'sess-ci-old', $2, current_date - 10, 6, 'athlete_post_session_self_report', 'bag work', true, now(), now())`,
    [ORG_ID, ATHLETE_ID],
  );
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  intelligence = await import('./coachIntelligence');
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

describe('getCoachIntelligence against the real schema', () => {
  test('every digest statement plans and runs for an athlete in scope', async () => {
    const digest = await intelligence.getCoachIntelligence(ORG_ID, [ATHLETE_ID]);

    // Item 4: the ten-day-old unreviewed session is past the 7-day threshold.
    expect(digest.unreviewed_sessions).toEqual([
      expect.objectContaining({ athlete_id: ATHLETE_ID, session_id: 'sess-ci-old', days_waiting: 10 }),
    ]);
    expect(digest.open_safety_escalations).toEqual([]);
    expect(digest.open_compliance_violations).toEqual([]);
  });
});
