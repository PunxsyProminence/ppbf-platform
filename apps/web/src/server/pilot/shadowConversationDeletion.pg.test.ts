/**
 * Deleting a SHADOW conversation deletes what the member typed, on real
 * PostgreSQL (lane HF7).
 *
 * Before this, "Delete" beside a chat and an office-completed "clear my
 * history" request only set deleted_at, and nothing ever removed the rows.
 * The rulings that decide what deletion does (Jason, recorded in
 * docs/current/OWNER_DECISIONS.md):
 *   - OD-2026-10-06-012: "delete any thing that personally Identifys the
 *     person but we keep data that male the Ai and ML bette3r";
 *   - OD-2026-10-06-023 Q1 "Delete theirs, keep AI replies (Recommended)" and
 *     Q2 "Keep until retention ends (Recommended)";
 *   - OD-2026-10-06-027 Q14 "2 years after deletion (Recommended)";
 *   - OD-2026-10-07-010 Q2: the nightly run deletes public enquiries and
 *     nothing of a person's ("people's records stay manual").
 * Applied to a member's own deletion under OD-2026-10-13-013 (Overwatch's GO
 * on PR #2062):
 *   - not flagged: their own messages are deleted now; SHADOW's replies are
 *     kept under a one-off anon_<uuid> token with their recorded names
 *     scrubbed, and every id that joined a reply back to them is cleared;
 *   - flagged into a safeguarding review: hidden from them and otherwise kept
 *     intact and identified; the office still reads the one flagged exchange;
 *   - two years after its deletion a flagged chat is cleared the same way, by
 *     the retention script on a manual APPLY only.
 *
 * Spins up the disposable, local-only embedded Postgres the other suites use.
 * It NEVER connects to production or staging.
 */

import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
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
    return (await activeClient.query(text, params)).rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    return (await activeClient.query(text, params)).rows[0] ?? null;
  }),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    await activeClient.query('BEGIN');
    try {
      const result = await fn(activeClient);
      await activeClient.query('COMMIT');
      return result;
    } catch (error) {
      await activeClient.query('ROLLBACK');
      throw error;
    }
  }),
}));

import type { ActorIdentity } from './access';
import * as conversations from './shadowConversations';

const {
  appendAssistantMessage,
  appendConversationExchange,
  completeShadowDataDeletionRequest,
  listConversations,
  listShadowDataDeletionRequests,
  loadHumanReviewExchange,
} = conversations;
// Looked up by name so this suite runs (and fails by assertion) against a
// build that does not have it yet.
const deleteOwnConversation = (conversations as unknown as Record<string, unknown>).deleteOwnConversation as
  ((actor: ActorIdentity, conversationId: string) => Promise<boolean>) | undefined;

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-conversation-deletion-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-hf7';
const OTHER_ORG = 'org-hf7-other';
const ATHLETE = 'ath-hf7-jordan';
const MEMBER = 'acct-hf7-athlete';
const PARENT = 'dana.pike@example.test';
const OTHER_MEMBER = 'acct-hf7-other';
const NAMELESS = 'acct-hf7-nameless';
const COACH = 'acct-hf7-coach';
const ADMIN = 'acct-hf7-admin';
const OTHER_ADMIN = 'acct-hf7-other-admin';

const TOKEN = /^anon_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const memberActor: ActorIdentity = { accountId: MEMBER, role: 'athlete', organizationId: ORG, athleteId: ATHLETE };
const parentActor: ActorIdentity = { accountId: PARENT, role: 'parent', organizationId: ORG, athleteId: null };
const namelessActor: ActorIdentity = { accountId: NAMELESS, role: 'athlete', organizationId: ORG, athleteId: null };
const adminActor: ActorIdentity = { accountId: ADMIN, role: 'organization_admin', organizationId: ORG, athleteId: null };
const otherAdminActor: ActorIdentity = {
  accountId: OTHER_ADMIN, role: 'organization_admin', organizationId: OTHER_ORG, athleteId: null,
};

/* The member's words and SHADOW's reply. The reply names the member three
   ways (full name, ring name, a part of the login email) and the child the
   chat is about; the words that are not names must survive the scrub. */
const USER_WORDS = 'I am Jordan Pike, call me Lightning, my login is jpike2013. My wrist hurts after sparring.';
const REPLY_WORDS = 'Jordan, Lightning is a good ring name. Pike, rest the wrist and tell your coach jpike2013 today.';
const KEPT_REPLY_WORDS = 'rest the wrist and tell your coach';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let mainDb: Client;
let sweepDb: Client;
const MAIN_DB_NAME = 'ppbf_test_hf7_deletion';
const SWEEP_DB_NAME = 'ppbf_test_hf7_sweep';

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
  const { applyFullSchema } = (await nativeDynamicImport(
    pathToFileURL(FULL_SCHEMA_HELPER_PATH).href,
  )) as { applyFullSchema: (c: Client) => Promise<void> };
  await applyFullSchema(client);
  await seedPeople(client);
  return client;
}

async function seedPeople(db: Client): Promise<void> {
  for (const organization of [ORG, OTHER_ORG]) {
    await db.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organization],
    );
    // The Library passage a reply cites (the evidence rows need one).
    await db.query(
      `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, rights_status)
       values ('src-' || $1, $1, 'Source', 'book', 1, 'ppbf_owned')`,
      [organization],
    );
    await db.query(
      `insert into pilot.shadow_library_documents (document_id, source_id, organization_id, document_name)
       values ('doc-' || $1, 'src-' || $1, $1, 'Doc')`,
      [organization],
    );
    await db.query(
      `insert into pilot.shadow_library_chunks (chunk_id, document_id, source_id, organization_id, ordinal, text_content)
       values ('chunk-' || $1, 'doc-' || $1, 'src-' || $1, $1, 1, 'text')`,
      [organization],
    );
  }
  for (const [accountId, role, organization, athleteId, loginEmail] of [
    [COACH, 'coach', ORG, null, null],
    [MEMBER, 'athlete', ORG, ATHLETE, 'jpike2013@example.test'],
    [PARENT, 'parent', ORG, null, null],
    [OTHER_MEMBER, 'athlete', ORG, null, 'other.kid@example.test'],
    [NAMELESS, 'athlete', ORG, null, null],
    [ADMIN, 'organization_admin', ORG, null, null],
    [OTHER_ADMIN, 'organization_admin', OTHER_ORG, null, null],
  ] as const) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, login_email, auth_provider)
       values ($1, $2, $3, $4, $5, 'microsoft')`,
      [accountId, role, organization, athleteId, loginEmail],
    );
  }
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Jordan Pike', '2012-04-03', 'youth-60', 'active', 'Guardian', true, $3, now(), now())`,
    [ORG, ATHLETE, COACH],
  );
  await db.query(
    `insert into pilot.account_profiles (organization_id, account_id, display_nickname) values ($1, $2, 'Lightning')`,
    [ORG, MEMBER],
  );
  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
     values ($1, 'par-hf7', $2, 'Dana Pike', '555-0100', 'dana.pike@example.test')`,
    [ORG, PARENT],
  );
}

interface SeededConversation {
  conversationId: string;
  userMessageId: string;
  replyId: string;
  reviewId: string | null;
  feedbackId: string;
  jobId: string;
}

let seq = 0;

/** One conversation with one exchange, and every row that copies the reply's id. */
async function seedConversation(db: Client, input: {
  organizationId: string;
  accountId: string;
  role: string;
  athleteId?: string | null;
  flagged?: boolean;
  deletedAgo?: string | null;
  userWords?: string;
  replyWords?: string;
}): Promise<SeededConversation> {
  seq += 1;
  const conversationId = (await db.query(
    `insert into pilot.shadow_chat_sessions
       (conversation_id, organization_id, account_id, athlete_id, title, session_type, deleted_at, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, $3, $4, 'quick_round',
             case when $5::text is null then null else now() - $5::interval end, now(), now())
     returning conversation_id`,
    [input.organizationId, input.accountId, input.athleteId ?? null, `My wrist, Jordan Pike ${seq}`, input.deletedAgo ?? null],
  )).rows[0].conversation_id as string;
  const userMessageId = (await db.query(
    `insert into pilot.shadow_chat_messages
       (message_id, conversation_id, organization_id, account_id, role, content, topic, session_type, created_at)
     values (gen_random_uuid(), $1, $2, $3, 'user', $4, 'injury', 'quick_round', now() - interval '1 minute')
     returning message_id`,
    [conversationId, input.organizationId, input.accountId, input.userWords ?? USER_WORDS],
  )).rows[0].message_id as string;
  const replyId = (await db.query(
    `insert into pilot.shadow_chat_messages
       (message_id, conversation_id, organization_id, account_id, role, content, response_state, topic, session_type, created_at)
     values (gen_random_uuid(), $1, $2, $3, 'assistant', $4, 'ok', 'injury', 'quick_round', now())
     returning message_id`,
    [conversationId, input.organizationId, input.accountId, input.replyWords ?? REPLY_WORDS],
  )).rows[0].message_id as string;

  const bundleId = (await db.query(`select gen_random_uuid() as id`)).rows[0].id as string;
  const evidenceId = (await db.query(`select gen_random_uuid() as id`)).rows[0].id as string;
  await db.query(
    `insert into pilot.shadow_evidence_bundles (bundle_id, organization_id, account_id, query_sha256, availability, item_count)
     values ($1, $2, $3, repeat('c', 64), 'available', 1)`,
    [bundleId, input.organizationId, input.accountId],
  );
  await db.query(
    `insert into pilot.shadow_evidence_items (evidence_id, bundle_id, organization_id, account_id, source_id, document_id, chunk_id, ordinal, excerpt_sha256, library_organization_id)
     values ($1, $2, $3, $4, 'src-' || $3, 'doc-' || $3, 'chunk-' || $3, 1, repeat('d', 64), $3)`,
    [evidenceId, bundleId, input.organizationId, input.accountId],
  );
  await db.query(
    `insert into pilot.shadow_evidence_claims (claim_id, organization_id, account_id, conversation_id, assistant_message_id, bundle_id, claim_status)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, 'supported')`,
    [input.organizationId, input.accountId, conversationId, replyId, bundleId],
  );
  await db.query(
    `insert into pilot.shadow_message_citations (assistant_message_id, evidence_id, bundle_id, organization_id, account_id, ordinal)
     values ($1, $2, $3, $4, $5, 1)`,
    [replyId, evidenceId, bundleId, input.organizationId, input.accountId],
  );
  const feedbackId = (await db.query(
    `insert into pilot.shadow_feedback
       (organization_id, account_id, role, helpful, rating, comment, outcome_signal,
        correlation_type, correlation_id, recommendation_ref, verification_state, human_review_required)
     values ($1, $2, $3, false, 2, 'not helpful', 'thumbs_down', 'shadow_message', $4, $4, 'durable_client', true)
     returning feedback_id::text as id`,
    [input.organizationId, input.accountId, input.role, replyId],
  )).rows[0].id as string;
  await db.query(
    `insert into pilot.shadow_learning_events
       (organization_id, account_id, role, feedback_id, message_id, topic, outcome_signal, effectiveness_score)
     values ($1, $2, $3, $4::bigint, $5, 'injury', 'thumbs_down', 0.2)`,
    [input.organizationId, input.accountId, input.role, feedbackId, replyId],
  );
  await db.query(
    `insert into pilot.shadow_recommendation_effectiveness
       (organization_id, account_id, feedback_id, recommendation_id, recommendation_type, outcome, effectiveness_score)
     values ($1, $2, $3::bigint, $4, 'chat_answer', 'degraded', 0.2)`,
    [input.organizationId, input.accountId, feedbackId, replyId],
  );
  await db.query(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement,
        knowledge_gap, source_status, source_confidence_tier, source_verification_state,
        created_by_account_id, created_by_role, metadata)
     values ($1, 'shadow_learning_negative_outcome', 'shadow_learning_event', $2, 'Strengthen SHADOW guidance.',
             'gap', 'weak', 'LIMITED', 'unverified', $3, $4, jsonb_build_object('topic', 'injury'))`,
    [input.organizationId, replyId, input.accountId, input.role],
  );
  const jobId = (await db.query(
    `insert into pilot.shadow_jobs (job_type, organization_id, account_id, role, status, input_payload)
     values ('heavy_bag_session', $1, $2, $3, 'pending', jsonb_build_object('conversationId', $4::text, 'message', $5::text))
     returning job_id`,
    [input.organizationId, input.accountId, input.role, conversationId, input.userWords ?? USER_WORDS],
  )).rows[0].job_id as string;

  let reviewId: string | null = null;
  if (input.flagged) {
    reviewId = (await db.query(
      `insert into pilot.shadow_human_review_queue
         (review_id, organization_id, conversation_id, account_id, category, severity, summary, status, metadata)
       values (gen_random_uuid(), $1, $2, $3, 'safeguarding', 'high', 'A child may be at risk', 'resolved',
               jsonb_build_object('assistantMessageId', $4::text))
       returning review_id`,
      [input.organizationId, conversationId, input.accountId, replyId],
    )).rows[0].review_id as string;
  }
  return { conversationId, userMessageId, replyId, reviewId, feedbackId, jobId };
}

/** Everything stored for one conversation, for before/after comparison. */
async function snapshot(db: Client, conversationId: string): Promise<unknown> {
  const session = (await db.query(
    `select organization_id, account_id, athlete_id, title, deleted_at, deidentified_at, subject_deleted_at
       from pilot.shadow_chat_sessions where conversation_id = $1`,
    [conversationId],
  )).rows;
  const messages = (await db.query(
    `select message_id, account_id, role, content from pilot.shadow_chat_messages
      where conversation_id = $1 order by role`,
    [conversationId],
  )).rows;
  const claims = (await db.query(
    `select count(*)::int as n from pilot.shadow_evidence_claims where conversation_id = $1`,
    [conversationId],
  )).rows[0].n;
  const reviews = (await db.query(
    `select account_id, summary, metadata, deidentified_at from pilot.shadow_human_review_queue where conversation_id = $1`,
    [conversationId],
  )).rows;
  const jobs = (await db.query(
    `select status, input_payload, output_payload from pilot.shadow_jobs
      where input_payload->>'conversationId' = $1::text or output_payload->>'conversationId' = $1::text`,
    [conversationId],
  )).rows;
  return { session, messages, claims, reviews, jobs };
}

async function sessionRow(db: Client, conversationId: string) {
  return (await db.query(
    `select account_id, athlete_id, title, deleted_at, deidentified_at
       from pilot.shadow_chat_sessions where conversation_id = $1`,
    [conversationId],
  )).rows[0] as {
    account_id: string; athlete_id: string | null; title: string;
    deleted_at: Date | null; deidentified_at: Date | null;
  } | undefined;
}

async function messagesOf(db: Client, conversationId: string) {
  return (await db.query(
    `select message_id, account_id, role, content from pilot.shadow_chat_messages
      where conversation_id = $1 order by role`,
    [conversationId],
  )).rows as Array<{ message_id: string; account_id: string; role: string; content: string }>;
}

/** The joins from the member's own rows to a reply, each of which must be cut. */
async function replyLinks(db: Client, seeded: SeededConversation) {
  const feedback = (await db.query(
    `select account_id, correlation_id, recommendation_ref, human_review_required, comment
       from pilot.shadow_feedback where feedback_id = $1::bigint`,
    [seeded.feedbackId],
  )).rows[0];
  const learning = (await db.query(
    `select message_id from pilot.shadow_learning_events where feedback_id = $1::bigint`,
    [seeded.feedbackId],
  )).rows[0];
  const effectiveness = (await db.query(
    `select recommendation_id from pilot.shadow_recommendation_effectiveness where feedback_id = $1::bigint`,
    [seeded.feedbackId],
  )).rows[0];
  const research = (await db.query(
    `select count(*)::int as n from pilot.shadow_research_requirements where source_entity_id = $1`,
    [seeded.replyId],
  )).rows[0].n;
  const citations = (await db.query(
    `select count(*)::int as n from pilot.shadow_message_citations where assistant_message_id = $1`,
    [seeded.replyId],
  )).rows[0].n;
  const claims = (await db.query(
    `select count(*)::int as n from pilot.shadow_evidence_claims where assistant_message_id = $1 or conversation_id = $2`,
    [seeded.replyId, seeded.conversationId],
  )).rows[0].n;
  const job = (await db.query(
    `select status, input_payload, output_payload from pilot.shadow_jobs where job_id = $1`,
    [seeded.jobId],
  )).rows[0];
  return { feedback, learning, effectiveness, research, citations, claims, job };
}

function expectNoNames(content: string, names: string[]): void {
  for (const name of names) {
    expect(content.toLowerCase()).not.toContain(name.toLowerCase());
  }
}

async function runCleanup(dbName: string, mode: 'dry' | 'nightly' | 'apply'): Promise<Record<string, unknown>> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      process.execPath,
      [CLEANUP_SCRIPT],
      {
        env: {
          ...process.env,
          AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(dbName),
          PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
          PPBF_EXPECTED_POSTGRES_DATABASE: dbName,
          PPBF_POSTGRES_DISABLE_SSL: 'true',
          ...(mode === 'apply' ? { PPBF_RETENTION_APPLY: 'true' } : {}),
          ...(mode === 'nightly' ? { PPBF_RETENTION_APPLY_INQUIRIES: 'true' } : {}),
        },
      },
      (error, stdout, stderr) => (error ? reject(new Error(`${stdout}${stderr}`)) : resolve(`${stdout}${stderr}`)),
    );
  });
  const line = output.split('\n').find((entry) => entry.trim().startsWith('{'));
  const event = JSON.parse(line ?? '{}') as Record<string, unknown>;
  expect(event.blocked_by ?? {}).toEqual({});
  return event;
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
  mainDb = await freshDatabase(MAIN_DB_NAME);
  sweepDb = await freshDatabase(SWEEP_DB_NAME);
  activeClient = mainDb;
});

afterAll(async () => {
  activeClient = null;
  await mainDb?.end();
  await sweepDb?.end();
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
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  activeClient = mainDb;
});

describe('T1: a member deletes a chat nobody flagged', () => {
  test('their words are deleted, SHADOW\'s reply is kept without their names, and nothing else moves', async () => {
    expect(typeof deleteOwnConversation).toBe('function');
    const target = await seedConversation(mainDb, { organizationId: ORG, accountId: MEMBER, role: 'athlete', athleteId: ATHLETE });
    const ownOther = await seedConversation(mainDb, { organizationId: ORG, accountId: MEMBER, role: 'athlete' });
    const otherPerson = await seedConversation(mainDb, { organizationId: ORG, accountId: OTHER_MEMBER, role: 'athlete' });
    const otherGym = await seedConversation(mainDb, { organizationId: OTHER_ORG, accountId: MEMBER, role: 'athlete' });
    const untouched = [ownOther, otherPerson, otherGym];
    const before = await Promise.all(untouched.map((seeded) => snapshot(mainDb, seeded.conversationId)));
    const otherLinksBefore = await Promise.all(untouched.map((seeded) => replyLinks(mainDb, seeded)));

    // Not theirs, or not in their gym: refused, and nothing changes.
    await expect(deleteOwnConversation!(memberActor, otherPerson.conversationId)).resolves.toBe(false);
    await expect(deleteOwnConversation!({ ...memberActor, organizationId: OTHER_ORG }, target.conversationId))
      .resolves.toBe(false);

    await expect(deleteOwnConversation!(memberActor, target.conversationId)).resolves.toBe(true);

    // R1: what they typed is gone.
    const messages = await messagesOf(mainDb, target.conversationId);
    expect(messages.filter((message) => message.role === 'user')).toEqual([]);
    expect((await mainDb.query(`select count(*)::int as n from pilot.shadow_chat_messages where message_id = $1`,
      [target.userMessageId])).rows[0].n).toBe(0);

    // R2: SHADOW's reply is kept, de-identified.
    const replies = messages.filter((message) => message.role === 'assistant');
    expect(replies).toHaveLength(1);
    const [reply] = replies;
    expect(reply.account_id).toMatch(TOKEN);
    expect(reply.content).toContain(KEPT_REPLY_WORDS);
    expect(reply.content).toContain('[name]');
    expectNoNames(reply.content, ['Jordan', 'Pike', 'Lightning', 'jpike2013']);
    const session = await sessionRow(mainDb, target.conversationId);
    expect(session?.account_id).toBe(reply.account_id);
    expect(session?.athlete_id).toBe(reply.account_id);
    expect(session?.deidentified_at).not.toBeNull();
    expect(session?.deleted_at).not.toBeNull();
    expectNoNames(session?.title ?? '', ['Jordan', 'Pike', 'wrist']);

    // Every id that joined the reply back to the member is cut.
    const links = await replyLinks(mainDb, target);
    expect(links.feedback.account_id).toBe(MEMBER);
    expect(links.feedback.correlation_id).toBeNull();
    expect(links.feedback.recommendation_ref).toBeNull();
    expect(links.feedback.human_review_required).toBe(false);
    expect(links.learning.message_id).toBe('');
    expect(links.effectiveness.recommendation_id).toBeNull();
    expect(links.research).toBe(0);
    expect(links.citations).toBe(0);
    expect(links.claims).toBe(0);
    expect(links.job.status).toBe('cancelled');
    expect(links.job.input_payload).toEqual({});
    expect(links.job.output_payload).toBeNull();

    // The member no longer sees it; their other chat is still there.
    const listed = (await listConversations(memberActor, 100)).map((row) => row.conversationId);
    expect(listed).not.toContain(target.conversationId);
    expect(listed).toContain(ownOther.conversationId);

    // Their other chat, another member's, and the same login's chat in the
    // other gym are exactly as they were.
    const after = await Promise.all(untouched.map((seeded) => snapshot(mainDb, seeded.conversationId)));
    expect(after).toEqual(before);
    const otherLinksAfter = await Promise.all(untouched.map((seeded) => replyLinks(mainDb, seeded)));
    expect(otherLinksAfter).toEqual(otherLinksBefore);

    // A second delete finds nothing of theirs.
    await expect(deleteOwnConversation!(memberActor, target.conversationId)).resolves.toBe(false);
  });

  test('T5: nothing can be added to it afterwards, by the chat or by a background job', async () => {
    const target = await seedConversation(mainDb, { organizationId: ORG, accountId: MEMBER, role: 'athlete' });
    await expect(deleteOwnConversation!(memberActor, target.conversationId)).resolves.toBe(true);
    await expect(appendConversationExchange({
      actor: memberActor,
      conversationId: target.conversationId,
      userMessage: 'one more question',
      assistantMessage: 'one more answer',
      sessionType: 'quick_round',
      topic: 'general',
      responseState: 'ok',
    })).rejects.toThrow('SHADOW_CONVERSATION_NOT_FOUND');
    await expect(appendAssistantMessage({
      actor: memberActor,
      conversationId: target.conversationId,
      content: 'a late background answer',
      topic: 'general',
      sessionType: 'heavy_bag',
      responseState: 'ok',
    })).rejects.toThrow('SHADOW_CONVERSATION_NOT_FOUND');
    const messages = await messagesOf(mainDb, target.conversationId);
    expect(messages.map((message) => message.role)).toEqual(['assistant']);
  });
});

describe('T2: a member deletes a chat flagged into a safeguarding review', () => {
  test('it is hidden from them and otherwise kept intact; the office still reads the one exchange', async () => {
    const target = await seedConversation(mainDb, {
      organizationId: ORG, accountId: MEMBER, role: 'athlete', athleteId: ATHLETE, flagged: true,
    });
    const before = (await snapshot(mainDb, target.conversationId)) as {
      session: Array<Record<string, unknown>>; messages: unknown; claims: number; reviews: unknown;
    };

    await expect(deleteOwnConversation!(memberActor, target.conversationId)).resolves.toBe(true);

    const after = (await snapshot(mainDb, target.conversationId)) as typeof before;
    expect(after.messages).toEqual(before.messages);
    expect(after.claims).toEqual(before.claims);
    expect(after.reviews).toEqual(before.reviews);
    const session = await sessionRow(mainDb, target.conversationId);
    expect(session?.account_id).toBe(MEMBER);
    expect(session?.athlete_id).toBe(ATHLETE);
    expect(session?.deidentified_at).toBeNull();
    expect(session?.deleted_at).not.toBeNull();
    expect((await listConversations(memberActor, 100)).map((row) => row.conversationId))
      .not.toContain(target.conversationId);

    const exchange = await loadHumanReviewExchange({
      organizationId: ORG,
      reviewId: target.reviewId!,
      reader: { accountId: ADMIN, role: 'organization_admin' },
    });
    expect(exchange).toMatchObject({ recorded: true });
    if (exchange?.recorded) {
      expect(exchange.userMessage?.content).toBe(USER_WORDS);
      expect(exchange.assistantMessage.content).toBe(REPLY_WORDS);
    }
  });
});

describe('T3: the office completes a member\'s request', () => {
  test('every unflagged chat is cleared, the flagged one is held, and nobody else is touched', async () => {
    const aboutChild = await seedConversation(mainDb, {
      organizationId: ORG, accountId: PARENT, role: 'parent', athleteId: ATHLETE,
      userWords: 'This is Dana Pike, Jordan\'s mom. Is sparring safe?',
      replyWords: 'Dana, Jordan can spar under supervision. Ask the coach about headgear.',
    });
    const deletedEarlier = await seedConversation(mainDb, {
      organizationId: ORG, accountId: PARENT, role: 'parent', deletedAgo: '3 days',
      userWords: 'Dana here again.', replyWords: 'Hello Dana. Hydration matters.',
    });
    const flagged = await seedConversation(mainDb, {
      organizationId: ORG, accountId: PARENT, role: 'parent', flagged: true,
      userWords: 'Something at home worries me, Dana Pike.', replyWords: 'Thank you, Dana. Please talk to the office.',
    });
    const someoneElse = await seedConversation(mainDb, { organizationId: ORG, accountId: OTHER_MEMBER, role: 'athlete' });
    const someoneElseBefore = await snapshot(mainDb, someoneElse.conversationId);
    const flaggedBefore = (await snapshot(mainDb, flagged.conversationId)) as { messages: unknown; reviews: unknown };

    const requestId = (await mainDb.query(
      `insert into pilot.shadow_data_deletion_requests (request_id, organization_id, account_id)
       values (gen_random_uuid(), $1, $2) returning request_id`,
      [ORG, PARENT],
    )).rows[0].request_id as string;

    const queued = (await listShadowDataDeletionRequests(adminActor, 'pending'))
      .find((row) => row.requestId === requestId) as unknown as Record<string, unknown>;
    expect(queued.conversationsPending).toBe(2);
    expect(queued.conversationsHeld).toBe(1);

    // Another gym's admin cannot reach it.
    await expect(completeShadowDataDeletionRequest(otherAdminActor, requestId))
      .rejects.toThrow('SHADOW_DELETION_REQUEST_NOT_ACTIONABLE');

    const outcome = await completeShadowDataDeletionRequest(adminActor, requestId) as unknown as Record<string, unknown>;
    expect(outcome).toMatchObject({ requestId, status: 'completed', conversationsCleared: 2, conversationsHeld: 1 });

    for (const cleared of [aboutChild, deletedEarlier]) {
      const messages = await messagesOf(mainDb, cleared.conversationId);
      expect(messages.map((message) => message.role)).toEqual(['assistant']);
      expect(messages[0].account_id).toMatch(TOKEN);
      expectNoNames(messages[0].content, ['Dana', 'Pike', 'Jordan']);
      expect((await sessionRow(mainDb, cleared.conversationId))?.deidentified_at).not.toBeNull();
    }
    expect((await messagesOf(mainDb, aboutChild.conversationId))[0].content).toContain('Ask the coach about headgear');
    // Each cleared chat has its own token: two kept chats do not read as one person's.
    const tokens = await Promise.all([aboutChild, deletedEarlier].map(async (cleared) =>
      (await sessionRow(mainDb, cleared.conversationId))?.account_id));
    expect(new Set(tokens).size).toBe(2);

    const flaggedAfter = (await snapshot(mainDb, flagged.conversationId)) as typeof flaggedBefore;
    expect(flaggedAfter.messages).toEqual(flaggedBefore.messages);
    expect(flaggedAfter.reviews).toEqual(flaggedBefore.reviews);
    const heldSession = await sessionRow(mainDb, flagged.conversationId);
    expect(heldSession?.account_id).toBe(PARENT);
    expect(heldSession?.deleted_at).not.toBeNull();

    expect(await snapshot(mainDb, someoneElse.conversationId)).toEqual(someoneElseBefore);
    const request = (await mainDb.query(
      `select status, account_id from pilot.shadow_data_deletion_requests where request_id = $1`,
      [requestId],
    )).rows[0];
    expect(request).toEqual({ status: 'completed', account_id: PARENT });

    await expect(completeShadowDataDeletionRequest(adminActor, requestId))
      .rejects.toThrow('SHADOW_DELETION_REQUEST_NOT_ACTIONABLE');
    expect((await listConversations(parentActor, 100)).map((row) => row.conversationId)).toEqual([]);
  });
});

describe('T4: a chat whose member has no name on record', () => {
  test('cannot be scrubbed, so it is deleted whole', async () => {
    const target = await seedConversation(mainDb, {
      organizationId: ORG, accountId: NAMELESS, role: 'athlete',
      userWords: 'question', replyWords: 'answer',
    });
    await expect(deleteOwnConversation!(namelessActor, target.conversationId)).resolves.toBe(true);
    expect(await sessionRow(mainDb, target.conversationId)).toBeUndefined();
    expect(await messagesOf(mainDb, target.conversationId)).toEqual([]);
  });
});

describe('T6 and T7: the retention script ends the two-year hold, on APPLY only', () => {
  test('a member-deleted flagged chat past two years and a member-deleted chat from before this change are cleared; nothing else is', async () => {
    activeClient = sweepDb;
    const expired = await seedConversation(sweepDb, {
      organizationId: ORG, accountId: OTHER_MEMBER, role: 'athlete', flagged: true, deletedAgo: '25 months',
      userWords: 'other.kid here, I am scared', replyWords: 'other.kid, please tell the office today.',
    });
    const stillHeld = await seedConversation(sweepDb, {
      organizationId: ORG, accountId: OTHER_MEMBER, role: 'athlete', flagged: true, deletedAgo: '23 months',
    });
    const legacy = await seedConversation(sweepDb, {
      organizationId: ORG, accountId: MEMBER, role: 'athlete', deletedAgo: '3 days',
    });
    const live = await seedConversation(sweepDb, { organizationId: ORG, accountId: MEMBER, role: 'athlete' });
    // A deleted athlete's mark (dataDeletion.ts markAthleteTiedRecords): the
    // athlete's own purge, two years after THEIR deletion, decides these --
    // a staff chat about them and their own login's chat. Not flagged, so
    // only the exclusion keeps the sweep off them.
    await sweepDb.query(
      `insert into pilot.athletes
         (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
          emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
       values ($1, 'ath-hf7-left', 'Riley Stone', '2011-02-09', 'youth-65', 'active', 'Guardian', false, $2,
               now(), now(), now() - interval '13 months')`,
      [ORG, COACH],
    );
    await sweepDb.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider)
       values ('acct-hf7-left', 'athlete', $1, 'ath-hf7-left', 'microsoft')`,
      [ORG],
    );
    const athleteMark = await seedConversation(sweepDb, {
      organizationId: ORG, accountId: COACH, role: 'coach', athleteId: 'ath-hf7-left', deletedAgo: '13 months',
    });
    const athleteOwn = await seedConversation(sweepDb, {
      organizationId: ORG, accountId: 'acct-hf7-left', role: 'athlete', deletedAgo: '13 months',
    });
    // A deleted guardian's chat, not yet due for the guardian's own purge
    // (one year): that purge decides it.
    await sweepDb.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider, deleted_at)
       values ('gone.guardian@example.test', 'parent', $1, 'ppbf_local', now() - interval '6 months')`,
      [ORG],
    );
    const deletedPerson = await seedConversation(sweepDb, {
      organizationId: ORG, accountId: 'gone.guardian@example.test', role: 'parent', deletedAgo: '6 months',
    });
    const untouched = [stillHeld, live, athleteMark, athleteOwn, deletedPerson];
    const untouchedBefore = await Promise.all(untouched.map((seeded) => snapshot(sweepDb, seeded.conversationId)));
    const dueBefore = await Promise.all([expired, legacy].map((seeded) => snapshot(sweepDb, seeded.conversationId)));

    // The nightly run (OD-2026-10-07-010) and a dry run count them and keep them.
    // An expired public enquiry is due too, so the nightly run deletes
    // something and COMMITS: with nothing of its own to delete it rolls back,
    // which would hide a sweep that wrongly ran in this mode (the mutation
    // run found exactly that).
    await sweepDb.query(
      `insert into pilot.public_interest_submissions
         (organization_id, full_name, email, phone, visitor_type, program_interest,
          preferred_contact_method, message, consent_to_contact, review_state, created_at)
       values ($1, 'Old Enquiry', 'old.enquiry@example.test', '555-0100', 'Parent / Guardian', 'Youth Development',
               'Email', 'please call', true, 'new', now() - interval '13 months')`,
      [ORG],
    );
    const nightly = await runCleanup(SWEEP_DB_NAME, 'nightly');
    expect(nightly.member_deleted_chats_due).toBe(2);
    expect(nightly.inquiries).toBe(1);
    expect(await Promise.all([expired, legacy].map((seeded) => snapshot(sweepDb, seeded.conversationId))))
      .toEqual(dueBefore);
    const dry = await runCleanup(SWEEP_DB_NAME, 'dry');
    expect(dry.member_deleted_chats_due).toBe(2);
    expect(dry.would_clear_member_deleted_chats).toBe(2);
    expect(await Promise.all([expired, legacy].map((seeded) => snapshot(sweepDb, seeded.conversationId))))
      .toEqual(dueBefore);

    const applied = await runCleanup(SWEEP_DB_NAME, 'apply');
    expect(applied.member_deleted_chats_cleared).toBe(2);

    for (const cleared of [expired, legacy]) {
      const messages = await messagesOf(sweepDb, cleared.conversationId);
      expect(messages.map((message) => message.role)).toEqual(['assistant']);
      expect(messages[0].account_id).toMatch(TOKEN);
      const session = await sessionRow(sweepDb, cleared.conversationId);
      expect(session?.account_id).toBe(messages[0].account_id);
      expect(session?.deidentified_at).not.toBeNull();
    }
    expectNoNames((await messagesOf(sweepDb, expired.conversationId))[0].content, ['other.kid']);
    expectNoNames((await messagesOf(sweepDb, legacy.conversationId))[0].content, ['Jordan', 'Pike', 'Lightning', 'jpike2013']);
    // The flagged chat's review entry takes the chat's token, so the entry
    // keeps its conversation and names nobody.
    const review = (await sweepDb.query(
      `select account_id, summary, metadata, deidentified_at, conversation_id
         from pilot.shadow_human_review_queue where review_id = $1`,
      [expired.reviewId],
    )).rows[0];
    expect(review.account_id).toBe((await sessionRow(sweepDb, expired.conversationId))?.account_id);
    expect(review.deidentified_at).not.toBeNull();
    expect(review.metadata).toEqual({});
    expect(review.conversation_id).toBe(expired.conversationId);
    expectNoNames(review.summary, ['other.kid']);
    const expiredLinks = await replyLinks(sweepDb, expired);
    expect(expiredLinks.feedback.correlation_id).toBeNull();
    expect(expiredLinks.learning.message_id).toBe('');
    expect(expiredLinks.effectiveness.recommendation_id).toBeNull();
    expect(expiredLinks.research).toBe(0);
    expect(expiredLinks.claims).toBe(0);

    expect(await Promise.all(untouched.map((seeded) => snapshot(sweepDb, seeded.conversationId))))
      .toEqual(untouchedBefore);

    // A second APPLY finds nothing more to clear.
    const again = await runCleanup(SWEEP_DB_NAME, 'apply');
    expect(again.member_deleted_chats_cleared ?? 0).toBe(0);
  });

  test('T7: the script and the delete control leave the same rows behind', async () => {
    activeClient = sweepDb;
    const words = { userWords: 'Jordan Pike asks about jab drills', replyWords: 'Jordan, Lightning, keep the jab long. Pike out.' };
    const byControl = await seedConversation(sweepDb, { organizationId: ORG, accountId: MEMBER, role: 'athlete', ...words });
    await expect(deleteOwnConversation!(memberActor, byControl.conversationId)).resolves.toBe(true);
    const byScript = await seedConversation(sweepDb, {
      organizationId: ORG, accountId: MEMBER, role: 'athlete', deletedAgo: '1 day', ...words,
    });
    await runCleanup(SWEEP_DB_NAME, 'apply');

    const shape = async (seeded: SeededConversation) => {
      const session = await sessionRow(sweepDb, seeded.conversationId);
      const messages = await messagesOf(sweepDb, seeded.conversationId);
      const links = await replyLinks(sweepDb, seeded);
      return {
        title: session?.title,
        tokened: TOKEN.test(session?.account_id ?? ''),
        athlete: session?.athlete_id === null ? null : TOKEN.test(session?.athlete_id ?? ''),
        deidentified: session?.deidentified_at !== null,
        messages: messages.map((message) => ({
          role: message.role, content: message.content, sameToken: message.account_id === session?.account_id,
        })),
        links: { ...links, job: { ...links.job } },
      };
    };
    expect(await shape(byScript)).toEqual(await shape(byControl));
  });
});
