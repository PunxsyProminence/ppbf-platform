// Real PostgreSQL-backed coverage for resolveShadowFeedbackReview (#122).
//
// #122 fixed audit findings C1/C2: `m.response_state = 'ok'` and
// `s.deleted_at IS NULL` were JOIN predicates, so feedback on a FILTERED
// answer -- which the client marks reviewable, and which lands with
// human_review_required = true -- could be neither approved NOR rejected.
// Both verbs 404'd forever, and since this queue is the only path that
// promotes learning, every stuck row also capped the human_reviewed counters.
//
// That fix shipped with mock-based tests only. The defect WAS the SQL, so a
// mock cannot prove the repair: it asserts against a hand-written row shape
// rather than against what Postgres returns for a real filtered message. This
// suite runs the real statement over real rows -- the post-#89 policy that
// exists because the worker's ambiguous-column bug shipped green through
// mocks (#89).
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import crypto from 'node:crypto';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-feedback-exit-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_feedback_exit';

const ORG_ID = 'org-feedback-exit';
const ACCOUNT_ID = 'acct-feedback-athlete';
const REVIEWER_ID = 'acct-feedback-admin';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let feedback: typeof import('./shadowFeedback');
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

/**
 * Create one assistant message in its own session, plus the feedback row a
 * client would write against it, and return the feedback id.
 */
async function seedRatedAnswer(options: {
  responseState: 'ok' | 'filtered';
  sessionDeleted: boolean;
}): Promise<number> {
  const conversationId = crypto.randomUUID();
  const messageId = crypto.randomUUID();

  await db.query(
    `insert into pilot.shadow_chat_sessions
       (conversation_id, organization_id, account_id, title, session_type, deleted_at)
     values ($1, $2, $3, 'Rated conversation', 'heavy_bag', $4)`,
    [conversationId, ORG_ID, ACCOUNT_ID, options.sessionDeleted ? new Date().toISOString() : null],
  );
  await db.query(
    `insert into pilot.shadow_chat_messages
       (message_id, conversation_id, organization_id, account_id, role, content, response_state, topic, session_type)
     values ($1, $2, $3, $4, 'assistant', 'answer body', $5, 'defense', 'heavy_bag')`,
    [messageId, conversationId, ORG_ID, ACCOUNT_ID, options.responseState],
  );

  const row = await db.queryOne<{ feedback_id: string }>(
    `insert into pilot.shadow_feedback
       (organization_id, account_id, role, helpful, comment, outcome_signal,
        correlation_type, correlation_id, verification_state, human_review_required)
     values ($1, $2, 'athlete', false, 'not useful', 'thumbs_down',
             'shadow_message', $3, 'durable_client', true)
     returning feedback_id`,
    [ORG_ID, ACCOUNT_ID, messageId],
  );
  return Number(row!.feedback_id);
}

async function stateOf(feedbackId: number): Promise<{
  verification_state: string;
  human_review_required: boolean;
}> {
  const row = await db.queryOne<{ verification_state: string; human_review_required: boolean }>(
    'select verification_state, human_review_required from pilot.shadow_feedback where feedback_id = $1',
    [feedbackId],
  );
  return row!;
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
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  for (const [accountId, role] of [[ACCOUNT_ID, 'athlete'], [REVIEWER_ID, 'organization_admin']]) {
    await migrateClient.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft') on conflict do nothing`,
      [accountId, role, ORG_ID],
    );
  }
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  db = await import('./db');
  feedback = await import('./shadowFeedback');
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

describe('the review queue always has an exit, against the real schema (C1/C2)', () => {
  test('feedback on a FILTERED answer can be rejected', async () => {
    const feedbackId = await seedRatedAnswer({ responseState: 'filtered', sessionDeleted: false });

    const review = await feedback.resolveShadowFeedbackReview({
      organizationId: ORG_ID,
      feedbackId,
      reviewerAccountId: REVIEWER_ID,
      decision: 'reject',
    });

    expect(review).not.toBeNull();
    expect(review).not.toBe('reject_only');
    // Rejecting clears the queue: the row stops demanding review.
    expect(await stateOf(feedbackId)).toEqual({
      verification_state: 'durable_client',
      human_review_required: false,
    });
  });

  test('feedback on a FILTERED answer refuses approval, with a reason, and stays reviewable', async () => {
    const feedbackId = await seedRatedAnswer({ responseState: 'filtered', sessionDeleted: false });

    const review = await feedback.resolveShadowFeedbackReview({
      organizationId: ORG_ID,
      feedbackId,
      reviewerAccountId: REVIEWER_ID,
      decision: 'approve',
    });

    expect(review).not.toBeNull();
    expect(review).toBe('reject_only');
    // Untouched: a refused approval must not consume the item, or Reject --
    // the reviewer's actual remaining action -- would be lost too.
    expect(await stateOf(feedbackId)).toEqual({
      verification_state: 'durable_client',
      human_review_required: true,
    });

    // ...and Reject still works afterwards.
    const rejected = await feedback.resolveShadowFeedbackReview({
      organizationId: ORG_ID,
      feedbackId,
      reviewerAccountId: REVIEWER_ID,
      decision: 'reject',
    });
    expect(rejected).not.toBe('reject_only');
    expect((await stateOf(feedbackId)).human_review_required).toBe(false);
  });

  test('feedback from a soft-deleted session can be rejected but not approved', async () => {
    const feedbackId = await seedRatedAnswer({ responseState: 'ok', sessionDeleted: true });

    const blocked = await feedback.resolveShadowFeedbackReview({
      organizationId: ORG_ID,
      feedbackId,
      reviewerAccountId: REVIEWER_ID,
      decision: 'approve',
    });
    expect(blocked).toBe('reject_only');
    expect((await stateOf(feedbackId)).human_review_required).toBe(true);

    const rejected = await feedback.resolveShadowFeedbackReview({
      organizationId: ORG_ID,
      feedbackId,
      reviewerAccountId: REVIEWER_ID,
      decision: 'reject',
    });
    expect(rejected).not.toBe('reject_only');
    expect((await stateOf(feedbackId)).human_review_required).toBe(false);
  });

  test('a live, unfiltered answer still promotes to human_reviewed on approve', async () => {
    const feedbackId = await seedRatedAnswer({ responseState: 'ok', sessionDeleted: false });

    const review = await feedback.resolveShadowFeedbackReview({
      organizationId: ORG_ID,
      feedbackId,
      reviewerAccountId: REVIEWER_ID,
      decision: 'approve',
    });

    expect(review).not.toBe('reject_only');
    expect((review as { alreadyResolved: boolean }).alreadyResolved).toBe(false);
    expect((review as { topic: string }).topic).toBe('defense');
    expect(await stateOf(feedbackId)).toEqual({
      verification_state: 'human_reviewed',
      human_review_required: false,
    });
  });

  test('cross-organization resolution finds nothing', async () => {
    const feedbackId = await seedRatedAnswer({ responseState: 'ok', sessionDeleted: false });

    const review = await feedback.resolveShadowFeedbackReview({
      organizationId: 'org-somebody-else',
      feedbackId,
      reviewerAccountId: REVIEWER_ID,
      decision: 'reject',
    });

    expect(review).toBeNull();
    expect((await stateOf(feedbackId)).human_review_required).toBe(true);
  });

  test('an approval cannot be reversed by a later reject', async () => {
    const feedbackId = await seedRatedAnswer({ responseState: 'ok', sessionDeleted: false });
    await feedback.resolveShadowFeedbackReview({
      organizationId: ORG_ID,
      feedbackId,
      reviewerAccountId: REVIEWER_ID,
      decision: 'approve',
    });

    const reversal = await feedback.resolveShadowFeedbackReview({
      organizationId: ORG_ID,
      feedbackId,
      reviewerAccountId: REVIEWER_ID,
      decision: 'reject',
    });

    expect(reversal).toBeNull();
    expect((await stateOf(feedbackId)).verification_state).toBe('human_reviewed');
  });
});
