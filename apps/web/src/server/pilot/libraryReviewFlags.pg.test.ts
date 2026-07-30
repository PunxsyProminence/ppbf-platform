// Real PostgreSQL-backed test for the library review-flag lifecycle.
//
// The learning loop has upserted flags since it shipped, but nothing could
// ever read them in full or move one off 'pending' -- the schema's
// reviewed_by_account_id / reviewed_at columns had no writer. This suite runs
// the new route handlers (GET list, PATCH verdict) against the real schema,
// and pins the one contract that makes verdicts safe: the learning loop's
// ON CONFLICT upsert returns a settled topic to 'pending' when new negative
// feedback arrives, so 'resolved' is never permanent immunity.
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

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import { requirePrincipal } from './http';
import type { PilotPrincipal } from './auth';

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('./audit', () => ({ writePilotAuditEvent: jest.fn() }));

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-library-flags-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_library_flags';

const ORG_ID = 'org-flags-test';
const OTHER_ORG_ID = 'org-flags-other';
const ACCOUNT_ID = 'acct-flags-curator';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let routes: {
  getFlags: (request: NextRequest) => Promise<Response>;
  patchFlag: (request: NextRequest) => Promise<Response>;
};
let db: typeof import('./db');

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

function principal(organizationId = ORG_ID): PilotPrincipal {
  return {
    accountId: ACCOUNT_ID,
    role: 'organization_admin',
    organizationId,
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

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

// The learning loop's exact upsert (queueClientSignalForReview): the writer
// half of the lifecycle under test. Kept verbatim so a drift between this and
// shadowLearningLoop.ts is a visible diff in review.
async function upsertFlagAsLearningLoop(topic: string, feedbackId: number | null): Promise<void> {
  await db.query(
    `INSERT INTO pilot.shadow_library_review_flags (
       organization_id, account_id, feedback_id, topic, session_type,
       outcome_signal, user_note, review_state, flagged_at, last_flagged_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW(), NOW())
     ON CONFLICT (organization_id, topic)
     DO UPDATE SET
       flag_count = pilot.shadow_library_review_flags.flag_count
         + CASE
             WHEN pilot.shadow_library_review_flags.feedback_id IS DISTINCT FROM EXCLUDED.feedback_id
             THEN 1
             ELSE 0
           END,
       account_id = EXCLUDED.account_id,
       feedback_id = EXCLUDED.feedback_id,
       session_type = EXCLUDED.session_type,
       outcome_signal = EXCLUDED.outcome_signal,
       user_note = EXCLUDED.user_note,
       last_flagged_at = NOW(),
       latest_outcome_signal = EXCLUDED.outcome_signal,
       review_state = 'pending'`,
    [ORG_ID, ACCOUNT_ID, feedbackId, topic, 'quick_round', 'not_helpful', 'Answer did not match our drills', ],
  );
}

// feedback_id is a real foreign key into shadow_feedback (this suite's first
// run proved it, by failing), so reopen tests insert genuine feedback rows.
async function insertFeedbackRow(): Promise<number> {
  const row = await db.queryOne<{ feedback_id: number }>(
    `INSERT INTO pilot.shadow_feedback (organization_id, account_id, role, helpful)
     VALUES ($1, $2, 'organization_admin', false)
     RETURNING feedback_id`,
    [ORG_ID, ACCOUNT_ID],
  );
  return row!.feedback_id;
}

async function flagRow(topic: string): Promise<{ flag_id: string; review_state: string; flag_count: number; reviewed_by_account_id: string | null } | null> {
  return db.queryOne(
    `SELECT flag_id, review_state, flag_count, reviewed_by_account_id
     FROM pilot.shadow_library_review_flags
     WHERE organization_id = $1 AND topic = $2`,
    [ORG_ID, topic],
  );
}

function getRequest(state?: string): NextRequest {
  const url = state
    ? `http://localhost/api/pilot/shadow/library/review-flags?state=${state}`
    : 'http://localhost/api/pilot/shadow/library/review-flags';
  return new NextRequest(url, { method: 'GET' });
}

function patchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/shadow/library/review-flags', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
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
  await migrateClient.query(
    await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_shadow_runtime_migration.sql'), 'utf8'),
  );
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await migrateClient.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
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
  db = await import('./db');
  routes = {
    getFlags: (await import('@/app/api/pilot/shadow/library/review-flags/route')).GET,
    patchFlag: (await import('@/app/api/pilot/shadow/library/review-flags/route')).PATCH,
  };
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

beforeEach(() => {
  mockRequirePrincipal.mockReset();
  mockRequirePrincipal.mockResolvedValue(principal());
});

describe('library review-flag lifecycle against the real schema', () => {
  test('a flagged topic lists as pending, takes a verdict, and leaves the pending list', async () => {
    await upsertFlagAsLearningLoop('footwork', null);

    const listResponse = await routes.getFlags(getRequest());
    const listPayload = await listResponse.json();
    expect(listResponse.status).toBe(200);
    const flag = listPayload.flags.find((f: { topic: string }) => f.topic === 'footwork');
    expect(flag).toMatchObject({ review_state: 'pending', flag_count: 1 });

    const patchResponse = await routes.patchFlag(patchRequest({
      flag_id: flag.flag_id,
      review_state: 'resolved',
      notes: 'Re-read the cited drill doc; the guidance is sound.',
    }));
    expect(patchResponse.status).toBe(200);

    const settled = await flagRow('footwork');
    expect(settled).toMatchObject({ review_state: 'resolved', reviewed_by_account_id: ACCOUNT_ID });

    const pendingAfter = await routes.getFlags(getRequest());
    const pendingPayload = await pendingAfter.json();
    expect(pendingPayload.flags.some((f: { topic: string }) => f.topic === 'footwork')).toBe(false);

    const allAfter = await routes.getFlags(getRequest('all'));
    const allPayload = await allAfter.json();
    expect(allPayload.flags.some((f: { topic: string }) => f.topic === 'footwork')).toBe(true);
  });

  test('a settled flag cannot take a second verdict, but new feedback reopens it for one', async () => {
    const firstFeedback = await insertFeedbackRow();
    await upsertFlagAsLearningLoop('southpaw defense', firstFeedback);
    const first = await flagRow('southpaw defense');
    await routes.patchFlag(patchRequest({ flag_id: first!.flag_id, review_state: 'rejected' }));

    // Re-judging a settled flag would overwrite who decided it: refused.
    const again = await routes.patchFlag(patchRequest({ flag_id: first!.flag_id, review_state: 'resolved' }));
    expect(again.status).toBe(404);

    // The learning loop's upsert returns the topic to 'pending' on NEW
    // negative feedback -- resolution is never permanent immunity.
    const secondFeedback = await insertFeedbackRow();
    await upsertFlagAsLearningLoop('southpaw defense', secondFeedback);
    const reopened = await flagRow('southpaw defense');
    expect(reopened).toMatchObject({ review_state: 'pending', flag_count: 2 });

    const verdictAfterReopen = await routes.patchFlag(
      patchRequest({ flag_id: first!.flag_id, review_state: 'resolved' }),
    );
    expect(verdictAfterReopen.status).toBe(200);
  });

  test('cross-org verdicts touch nothing and athletes cannot list flags', async () => {
    await upsertFlagAsLearningLoop('nutrition', null);
    const flag = await flagRow('nutrition');

    mockRequirePrincipal.mockResolvedValue(principal(OTHER_ORG_ID));
    const crossOrg = await routes.patchFlag(patchRequest({ flag_id: flag!.flag_id, review_state: 'resolved' }));
    expect(crossOrg.status).toBe(404);
    expect((await flagRow('nutrition'))!.review_state).toBe('pending');

    mockRequirePrincipal.mockResolvedValue({ ...principal(), role: 'athlete' });
    const athleteList = await routes.getFlags(getRequest());
    expect(athleteList.status).toBe(403);
  });
});
