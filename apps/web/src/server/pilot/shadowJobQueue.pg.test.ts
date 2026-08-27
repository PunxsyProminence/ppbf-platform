// Real PostgreSQL-backed test for the SHADOW job queue claim cycle.
//
// Written while diagnosing staging run 30563595088: a background Heavy Bag
// job was enqueued (INSERT worked), polled successfully sixty times (the
// status SELECT worked), and was never claimed in 300 seconds. Every part of
// the pipeline had real-database coverage except the part that moves jobs --
// claimNextJob's three-CTE claim statement, completeJob's lease-guarded
// update, and failJob's retry arithmetic had only ever run against jest
// mocks. A column, constraint, or SQL-semantics mismatch in exactly these
// statements would present precisely as that staging failure: enqueue and
// polling fine, drain dead.
//
// Spins up the same disposable, local-only embedded Postgres instance the
// other migration suites use (scripts/test-embedded-pg-server.mjs). It NEVER
// connects to production or staging. The schema is built the way staging's
// was: base schema, then the exact file list pilot:apply-shadow-runtime
// applies, in order.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { Client } from 'pg';

import type { ActorIdentity } from './access';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-job-queue-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_shadow_job_queue';

// Mirror of MIGRATION_FILES in scripts/pilot-apply-shadow-runtime-migration.mjs:
// the set of increments a real environment has applied on top of the base
// schema. Kept literal rather than imported so a drift between this list and
// the apply script is itself a visible diff in review.
const SHADOW_RUNTIME_MIGRATION_FILES = [
  'pilot_slice_postgres_shadow_runtime_migration.sql',
  'pilot_slice_postgres_shadow_formula_foundation_migration.sql',
  'pilot_slice_postgres_shadow_evidence_migration.sql',
  'pilot_slice_postgres_shadow_job_lease_migration.sql',
  'pilot_slice_postgres_board_role_migration.sql',
  'pilot_slice_postgres_shadow_decision_loop_migration.sql',
  'pilot_slice_postgres_shadow_chunk_embedding_migration.sql',
];

const ORG_ID = 'org-job-queue-test';
const ACCOUNT_ID = 'acct-job-admin';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let queue: typeof import('./shadowJobQueue');

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

function actor(): ActorIdentity {
  return {
    accountId: ACCOUNT_ID,
    organizationId: ORG_ID,
    role: 'organization_admin',
  } as ActorIdentity;
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
  /* Applied outside SHADOW_RUNTIME_MIGRATION_FILES on purpose -- that list is a
     deliberate mirror of scripts/pilot-apply-shadow-runtime-migration.mjs and
     must keep matching it. This one is here because PRODUCTION HAS IT: it adds
     pilot.athletes.deleted_at, which the authorization queries in access.ts now
     require, and deploy-production's schema check confirmed it live on the
     2026-08-27 release. */
  await migrateClient.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_data_retention_deletion_migration.sql'), 'utf8'),
  );
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
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ACCOUNT_ID, ORG_ID],
  );
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  // Imported only after the connection string is in place, so the app's lazily
  // constructed pool targets this disposable database.
  queue = await import('./shadowJobQueue');
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

describe('shadow job queue claim cycle against the real migrated schema', () => {
  test('an enqueued job is claimable, completable, and reads back with its output', async () => {
    const jobId = await queue.enqueueJob({
      jobType: 'heavy_bag_session',
      organizationId: ORG_ID,
      accountId: ACCOUNT_ID,
      role: 'organization_admin',
      inputPayload: { message: 'claim cycle test', conversationId: null },
    });
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/i);

    const pending = await queue.getJobStatusForActor(jobId, actor());
    expect(pending?.status).toBe('pending');

    // The statement under test: three CTEs, FOR UPDATE SKIP LOCKED, lease
    // minting. This is the exact call the worker loop makes every tick.
    const claimed = await queue.claimNextJob();
    expect(claimed).not.toBeNull();
    expect(claimed?.jobId).toBe(jobId);
    expect(claimed?.status).toBe('running');
    expect(claimed?.leaseToken).toMatch(/^[0-9a-f-]{36}$/i);
    expect(claimed?.inputPayload).toMatchObject({ message: 'claim cycle test' });

    // While leased, a second drain (another replica, an ops call) must not
    // steal the job.
    await expect(queue.claimNextJob()).resolves.toBeNull();

    await queue.completeJob(
      claimed!,
      { response: 'done', responseState: 'ok' },
      'passed',
    );
    const completed = await queue.getJobStatusForActor(jobId, actor());
    expect(completed?.status).toBe('completed');
    expect(completed?.safetyStatus).toBe('passed');
    expect(completed?.output).toMatchObject({ response: 'done' });
  });

  test('a failed job retries until max_retries, then stays failed', async () => {
    const jobId = await queue.enqueueJob({
      jobType: 'board_summary',
      organizationId: ORG_ID,
      accountId: ACCOUNT_ID,
      role: 'organization_admin',
      inputPayload: { message: 'retry test' },
    });

    const first = await queue.claimNextJob();
    expect(first?.jobId).toBe(jobId);
    await queue.failJob(first!, 'SHADOW_AI_UNAVAILABLE', { retryable: true });

    const afterRetryable = await queue.getJobStatusForActor(jobId, actor());
    expect(afterRetryable?.status).toBe('pending');

    const second = await queue.claimNextJob();
    expect(second?.jobId).toBe(jobId);
    await queue.failJob(second!, 'SHADOW_JOB_EXECUTION_FAILED', { retryable: false });

    const afterFatal = await queue.getJobStatusForActor(jobId, actor());
    expect(afterFatal?.status).toBe('failed');
    expect(afterFatal?.error).toBe('SHADOW_JOB_EXECUTION_FAILED');

    // A terminally failed job must not be claimable again.
    await expect(queue.claimNextJob()).resolves.toBeNull();
  });
});
