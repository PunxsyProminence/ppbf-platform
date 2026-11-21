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
 * What is kept takes new ids (conversation, messages, and at the two-year
 * clear the review entries), so nothing that copied the old ones -- a
 * background reply's id is a hash of its job's id; a safety escalation and the
 * office's read of a flagged exchange record the conversation's id -- joins
 * it. A safety escalation pointing at a chat holds it like a review entry
 * does. These cases came from the adversarial review on #2062.
 *
 * Spins up the disposable, local-only embedded Postgres the other suites use.
 * It NEVER connects to production or staging.
 */

import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { completeJob } from './shadowJobQueue';
import * as conversations from './shadowConversations';

const {
  appendAssistantMessage,
  appendConversationExchange,
  completeShadowDataDeletionRequest,
  listConversations,
  listShadowDataDeletionRequests,
  loadHumanReviewExchange,
  queueHumanReview,
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
const REPLY_WORDS = 'Jordan, Lightning is a good ring name. Pike, rest the wrist and tell your coach jpike2013 today. '
  + 'Ask Morgan Quill to sign the form.';
const KEPT_REPLY_WORDS = 'rest the wrist and tell your coach';
const NAMES_OF_THE_CHILD = ['Jordan', 'Pike', 'Lightning', 'jpike2013', 'Morgan', 'Quill'];

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
  // A second guardian, linked to the child, with no login and a different
  // surname: only the link names them.
  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
     values ($1, 'par-hf7-b', null, 'Morgan Quill', '555-0101', null)`,
    [ORG],
  );
  for (const parentId of ['par-hf7', 'par-hf7-b']) {
    await db.query(
      `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
       values ($1, $2, $3, 'guardian')`,
      [ORG, parentId, ATHLETE],
    );
  }
}

interface SeededConversation {
  conversationId: string;
  userMessageId: string;
  replyId: string;
  reviewId: string | null;
  escalationId: string | null;
  feedbackId: string;
  jobId: string;
  /** A word in the reply that is no name: finds the kept copy after its ids change. */
  ref: string;
}

/** The id appendAssistantMessage gives a background reply (messageIdForKey; checked against it below). */
function derivedReplyId(key: string): string {
  const hex = createHash('sha256').update(`shadow-assistant-message:${key}`).digest('hex');
  const version = `5${hex.slice(13, 16)}`;
  const variant = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}-${hex.slice(20, 32)}`;
}

let seq = 0;

/**
 * One conversation with one exchange, and every row that copies its ids: the
 * reply's evidence, the feedback that rated it and what the learning loop
 * copied from that, the background job that answered it (whose id the
 * reply's id is derived from), and, as asked, a review entry and a safety
 * escalation pointing at the conversation.
 */
async function seedConversation(db: Client, input: {
  organizationId: string;
  accountId: string;
  role: string;
  athleteId?: string | null;
  flagged?: boolean;
  escalated?: boolean;
  deletedAgo?: string | null;
  jobStatus?: 'pending' | 'running';
  /** Also a finished job whose stored answer names the chat (as the processor's completion output does). */
  completedJob?: boolean;
  /** The escalation's conversation id as a client could have sent it: upper case. */
  escalationIdUpperCase?: boolean;
  subjectDeletedAgo?: string;
  userWords?: string;
  replyWords?: string;
}): Promise<SeededConversation & { completedJobId: string | null }> {
  seq += 1;
  const ref = `ref${seq}x`;
  const conversationId = (await db.query(
    `insert into pilot.shadow_chat_sessions
       (conversation_id, organization_id, account_id, athlete_id, title, session_type, deleted_at, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, $3, $4, 'heavy_bag',
             case when $5::text is null then null else now() - $5::interval end, now(), now())
     returning conversation_id`,
    [input.organizationId, input.accountId, input.athleteId ?? null, `My wrist, Jordan Pike ${seq}`, input.deletedAgo ?? null],
  )).rows[0].conversation_id as string;
  const userMessageId = (await db.query(
    `insert into pilot.shadow_chat_messages
       (message_id, conversation_id, organization_id, account_id, role, content, topic, session_type, created_at)
     values (gen_random_uuid(), $1, $2, $3, 'user', $4, 'injury', 'heavy_bag', now() - interval '1 minute')
     returning message_id`,
    [conversationId, input.organizationId, input.accountId, input.userWords ?? USER_WORDS],
  )).rows[0].message_id as string;
  const running = input.jobStatus === 'running';
  const jobId = (await db.query(
    `insert into pilot.shadow_jobs
       (job_type, organization_id, account_id, subject_id, role, status, input_payload, lease_token, lease_expires_at, started_at)
     values ('heavy_bag_session', $1, $2, $3, $4, $5,
             jsonb_build_object('conversationId', $6::text, 'message', $7::text),
             case when $8 then gen_random_uuid() end,
             case when $8 then now() + interval '5 minutes' end,
             case when $8 then now() end)
     returning job_id`,
    [input.organizationId, input.accountId, input.athleteId ?? null, input.role, running ? 'running' : 'pending',
      conversationId, input.userWords ?? USER_WORDS, running],
  )).rows[0].job_id as string;
  let completedJobId: string | null = null;
  if (input.completedJob) {
    completedJobId = (await db.query(
      `insert into pilot.shadow_jobs
         (job_type, organization_id, account_id, subject_id, role, status, input_payload, output_payload, safety_status, completed_at)
       values ('heavy_bag_session', $1, $2, $3, $4, 'completed', '{}'::jsonb,
               jsonb_build_object('conversationId', $5::text, 'response', $6::text), 'passed', now())
       returning job_id`,
      [input.organizationId, input.accountId, input.athleteId ?? null, input.role, conversationId,
        `${input.replyWords ?? REPLY_WORDS} (stored answer)`],
    )).rows[0].job_id as string;
  }
  if (input.subjectDeletedAgo) {
    await db.query(
      `update pilot.shadow_chat_sessions set subject_deleted_at = now() - $2::interval where conversation_id = $1`,
      [conversationId, input.subjectDeletedAgo],
    );
  }
  // A background answer: its id is derived from the job's id.
  const replyId = derivedReplyId(jobId);
  await db.query(
    `insert into pilot.shadow_chat_messages
       (message_id, conversation_id, organization_id, account_id, role, content, response_state, topic, session_type, created_at)
     values ($1, $2, $3, $4, 'assistant', $5, 'ok', 'injury', 'heavy_bag', now())`,
    [replyId, conversationId, input.organizationId, input.accountId, `${input.replyWords ?? REPLY_WORDS} ${ref}`],
  );

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
  // A disclosure's escalation, filed with the conversation's id whether or
  // not its review entry was written (shadowDisclosure.ts escalationInput).
  let escalationId: string | null = null;
  if (input.escalated) {
    escalationId = (await db.query(
      `insert into pilot.safety_escalations
         (organization_id, escalation_id, source_type, athlete_id, severity, reason, escalated_to_role, triggered_by, metadata)
       values ($1, gen_random_uuid()::text, 'shadow_disclosure', $2, 'high', 'SHADOW disclosure', 'organization_admin', 'system',
               jsonb_build_object('channel', 'shadow_chat', 'conversation_id', $3::text))
       returning escalation_id`,
      [input.organizationId, ATHLETE, input.escalationIdUpperCase ? conversationId.toUpperCase() : conversationId],
    )).rows[0].escalation_id as string;
  }
  return { conversationId, userMessageId, replyId, reviewId, escalationId, feedbackId, jobId, ref, completedJobId };
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
    `select review_id, account_id, summary, metadata, deidentified_at from pilot.shadow_human_review_queue
      where conversation_id = $1`,
    [conversationId],
  )).rows;
  const jobs = (await db.query(
    `select job_id, status, input_payload, output_payload from pilot.shadow_jobs
      where input_payload->>'conversationId' = $1::text or output_payload->>'conversationId' = $1::text`,
    [conversationId],
  )).rows;
  const escalations = (await db.query(
    `select escalation_id, athlete_id from pilot.safety_escalations where metadata->>'conversation_id' = $1::text`,
    [conversationId],
  )).rows;
  return { session, messages, claims, reviews, jobs, escalations };
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
    `select message_id::text as message_id, account_id, role, content from pilot.shadow_chat_messages
      where conversation_id = $1 order by role`,
    [conversationId],
  )).rows as Array<{ message_id: string; account_id: string; role: string; content: string }>;
}

/** The kept copy of a cleared chat, found by its reply's marker word; null when nothing was kept. */
async function keptCopy(db: Client, seeded: SeededConversation): Promise<string | null> {
  const rows = (await db.query(
    `select distinct m.conversation_id::text as conversation_id from pilot.shadow_chat_messages m
      where m.role = 'assistant' and m.content like '%' || $1 || '%'`,
    [seeded.ref],
  )).rows as Array<{ conversation_id: string }>;
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0]?.conversation_id ?? null;
}

/** Nothing under any of the chat's old ids, and no job row for it. */
async function expectOldIdsGone(db: Client, seeded: SeededConversation): Promise<void> {
  expect(await sessionRow(db, seeded.conversationId)).toBeUndefined();
  const messages = (await db.query(
    `select count(*)::int as n from pilot.shadow_chat_messages
      where conversation_id = $1 or message_id = any($2::uuid[])`,
    [seeded.conversationId, [seeded.userMessageId, seeded.replyId, derivedReplyId(seeded.jobId)]],
  )).rows[0].n;
  expect(messages).toBe(0);
  expect((await db.query(`select count(*)::int as n from pilot.shadow_jobs where job_id = $1`, [seeded.jobId]))
    .rows[0].n).toBe(0);
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
  )).rows[0] ?? null;
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

describe('T0: the fixtures stand for what the app writes', () => {
  test('a background reply\'s id is the one appendAssistantMessage derives from the job id', async () => {
    const live = (await mainDb.query(
      `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, title)
       values (gen_random_uuid(), $1, $2, 'live') returning conversation_id`,
      [ORG, MEMBER],
    )).rows[0].conversation_id as string;
    const key = 'job-key-for-derivation-check';
    const id = await appendAssistantMessage({
      actor: memberActor, conversationId: live, content: 'answer', topic: 'general',
      sessionType: 'heavy_bag', responseState: 'ok', idempotencyKey: key,
    });
    expect(id).toBe(derivedReplyId(key));
    await mainDb.query(`delete from pilot.shadow_chat_sessions where conversation_id = $1`, [live]);
  });

  test('the session table has exactly the columns the clearing copies (a new column must be handled there)', async () => {
    const columns = (await mainDb.query(
      `select column_name from information_schema.columns
        where table_schema = 'pilot' and table_name = 'shadow_chat_sessions' order by column_name`,
    )).rows.map((row) => row.column_name);
    expect(columns).toEqual([
      'account_id', 'athlete_id', 'conversation_id', 'created_at', 'deidentified_at', 'deleted_at',
      'organization_id', 'session_type', 'subject_deleted_at', 'title', 'updated_at',
    ]);
  });
});

describe('T1: a member deletes a chat nobody flagged', () => {
  test('their words are deleted, SHADOW\'s reply is kept under new ids without their names, and nothing else moves', async () => {
    expect(typeof deleteOwnConversation).toBe('function');
    const target = await seedConversation(mainDb, {
      organizationId: ORG, accountId: MEMBER, role: 'athlete', athleteId: ATHLETE, completedJob: true,
    });
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

    // R1: what they typed is gone. Nothing is left under any old id; the
    // job row, whose id derives the reply's old id, is gone too.
    await expectOldIdsGone(mainDb, target);

    // R2: SHADOW's reply is kept, de-identified, under new ids.
    const keptId = await keptCopy(mainDb, target);
    expect(keptId).not.toBeNull();
    expect(keptId).not.toBe(target.conversationId);
    const messages = await messagesOf(mainDb, keptId!);
    expect(messages.map((message) => message.role)).toEqual(['assistant']);
    const [reply] = messages;
    expect(reply.message_id).not.toBe(target.replyId);
    expect(reply.account_id).toMatch(TOKEN);
    expect(reply.content).toContain(KEPT_REPLY_WORDS);
    expect(reply.content).toContain('[name]');
    // The member's names, the child's, and the names of the guardians
    // linked to the child (one with another surname and no login).
    expectNoNames(reply.content, NAMES_OF_THE_CHILD);
    const session = await sessionRow(mainDb, keptId!);
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
    expect(links.job).toBeNull();
    // A finished job's stored answer (SHADOW's words under the member's
    // account) goes with it.
    expect((await mainDb.query(`select count(*)::int as n from pilot.shadow_jobs where job_id = $1`,
      [target.completedJobId])).rows[0].n).toBe(0);
    // Kept times are the day, not the moment: an exact time would line the
    // kept rows up with the member's own rows (evidence, the chat log).
    const times = (await mainDb.query(
      `select extract(epoch from s.created_at - date_trunc('day', s.created_at)) as session_offset,
              extract(epoch from s.deidentified_at - date_trunc('day', s.deidentified_at)) as stamp_offset,
              extract(epoch from s.updated_at - date_trunc('day', s.updated_at)) as updated_offset,
              extract(epoch from s.deleted_at - date_trunc('day', s.deleted_at)) as deleted_offset,
              (select max(extract(epoch from m.created_at - date_trunc('day', m.created_at)))
                 from pilot.shadow_chat_messages m where m.conversation_id = s.conversation_id) as message_offset
         from pilot.shadow_chat_sessions s where s.conversation_id = $1`,
      [keptId],
    )).rows[0];
    for (const offset of Object.values(times)) expect(Number(offset)).toBeLessThan(1);

    // The member no longer sees it; their other chat is still there.
    const listed = (await listConversations(memberActor, 100)).map((row) => row.conversationId);
    expect(listed).not.toContain(target.conversationId);
    expect(listed).not.toContain(keptId);
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

  test('T5: a background job running for it can complete nothing, and nothing can be added afterwards', async () => {
    const target = await seedConversation(mainDb, {
      organizationId: ORG, accountId: MEMBER, role: 'athlete', jobStatus: 'running',
    });
    const lease = (await mainDb.query(`select lease_token::text as lease from pilot.shadow_jobs where job_id = $1`,
      [target.jobId])).rows[0].lease as string;
    await expect(deleteOwnConversation!(memberActor, target.conversationId)).resolves.toBe(true);

    // The worker finishes after the delete: there is no job to complete, so
    // SHADOW's unscrubbed answer is never stored under the member's account.
    await expect(completeJob(
      { jobId: target.jobId, organizationId: ORG, accountId: MEMBER, leaseToken: lease },
      { conversationId: target.conversationId, response: 'Jordan Pike, here is your answer.' },
      'passed',
    )).rejects.toThrow();
    expect((await mainDb.query(
      `select count(*)::int as n from pilot.shadow_jobs where account_id = $1 and output_payload::text like '%Jordan%'`,
      [MEMBER],
    )).rows[0].n).toBe(0);

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
      idempotencyKey: target.jobId,
    })).rejects.toThrow('SHADOW_CONVERSATION_NOT_FOUND');
    await expectOldIdsGone(mainDb, target);
  });
});

describe('T2: a member deletes a chat a safeguarding review or a safety escalation points at', () => {
  test('a reviewed chat is hidden from them and otherwise kept intact; the office still reads the one exchange', async () => {
    const target = await seedConversation(mainDb, {
      organizationId: ORG, accountId: MEMBER, role: 'athlete', athleteId: ATHLETE, flagged: true,
    });
    const before = (await snapshot(mainDb, target.conversationId)) as {
      session: Array<Record<string, unknown>>; messages: unknown; claims: number; reviews: unknown; jobs: unknown;
    };

    await expect(deleteOwnConversation!(memberActor, target.conversationId)).resolves.toBe(true);

    const after = (await snapshot(mainDb, target.conversationId)) as typeof before;
    expect(after.messages).toEqual(before.messages);
    expect(after.claims).toEqual(before.claims);
    expect(after.reviews).toEqual(before.reviews);
    expect(after.jobs).toEqual(before.jobs);
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
      expect(exchange.assistantMessage.content).toContain(REPLY_WORDS);
    }
  });

  test('a chat only a safety escalation points at (its review entry never written) is held the same way', async () => {
    const target = await seedConversation(mainDb, {
      organizationId: ORG, accountId: MEMBER, role: 'athlete', athleteId: ATHLETE, escalated: true,
      // Filed with the id as the client sent it; ids match whatever their case.
      escalationIdUpperCase: true,
    });
    const before = (await snapshot(mainDb, target.conversationId)) as { messages: unknown; escalations: unknown };

    await expect(deleteOwnConversation!(memberActor, target.conversationId)).resolves.toBe(true);

    const after = (await snapshot(mainDb, target.conversationId)) as typeof before;
    expect(after.messages).toEqual(before.messages);
    expect(after.escalations).toEqual(before.escalations);
    const session = await sessionRow(mainDb, target.conversationId);
    expect(session?.account_id).toBe(MEMBER);
    expect(session?.deidentified_at).toBeNull();
    expect(session?.deleted_at).not.toBeNull();
  });
});

describe('T2b: what arrives at the edges', () => {
  test('a chat the purge marked as held (subject_deleted_at) is held, not cleared', async () => {
    const target = await seedConversation(mainDb, {
      organizationId: ORG, accountId: MEMBER, role: 'athlete', subjectDeletedAgo: '1 day',
    });
    const before = (await snapshot(mainDb, target.conversationId)) as { messages: unknown };
    await expect(deleteOwnConversation!(memberActor, target.conversationId)).resolves.toBe(true);
    const after = (await snapshot(mainDb, target.conversationId)) as typeof before;
    expect(after.messages).toEqual(before.messages);
    expect((await sessionRow(mainDb, target.conversationId))?.deidentified_at).toBeNull();
  });

  test('a review row written after its chat was cleared is kept, without the chat', async () => {
    // The chat route writes its review row at the end of the request, after
    // the exchange is stored; a delete from another tab can land in between.
    // The row is a safety record and must not be lost to the foreign key.
    const target = await seedConversation(mainDb, { organizationId: ORG, accountId: MEMBER, role: 'athlete' });
    await expect(deleteOwnConversation!(memberActor, target.conversationId)).resolves.toBe(true);
    const reviewId = await queueHumanReview({
      organizationId: ORG,
      accountId: MEMBER,
      conversationId: target.conversationId,
      category: 'self_harm',
      severity: 'critical',
      summary: 'A high-risk request reached SHADOW.',
      metadata: { assistantMessageId: target.replyId },
    });
    const row = (await mainDb.query(
      `select conversation_id, account_id, severity from pilot.shadow_human_review_queue where review_id = $1`,
      [reviewId],
    )).rows[0];
    expect(row).toEqual({ conversation_id: null, account_id: MEMBER, severity: 'critical' });
  });
});

describe('T3: the office completes a member\'s request', () => {
  test('every unflagged chat is cleared, the flagged ones are held, and nobody else is touched', async () => {
    const aboutChild = await seedConversation(mainDb, {
      organizationId: ORG, accountId: PARENT, role: 'parent', athleteId: ATHLETE,
      userWords: 'This is Dana Pike, Jordan\'s mom. Is sparring safe?',
      replyWords: 'Dana, Jordan can spar under supervision. Ask the coach about headgear.',
    });
    const deletedEarlier = await seedConversation(mainDb, {
      organizationId: ORG, accountId: PARENT, role: 'parent', deletedAgo: '3 days',
      userWords: 'Dana here again.', replyWords: 'Hello Dana. Make sure Jordan and Morgan Quill pack water. Hydration matters.',
    });
    const flagged = await seedConversation(mainDb, {
      organizationId: ORG, accountId: PARENT, role: 'parent', flagged: true,
      userWords: 'Something at home worries me, Dana Pike.', replyWords: 'Thank you, Dana. Please talk to the office.',
    });
    const escalated = await seedConversation(mainDb, {
      organizationId: ORG, accountId: PARENT, role: 'parent', athleteId: ATHLETE, escalated: true,
      userWords: 'Jordan told me something.', replyWords: 'Thank you, Dana. The office will help.',
    });
    const someoneElse = await seedConversation(mainDb, { organizationId: ORG, accountId: OTHER_MEMBER, role: 'athlete' });
    const someoneElseBefore = await snapshot(mainDb, someoneElse.conversationId);
    const heldBefore = await Promise.all([flagged, escalated].map((seeded) => snapshot(mainDb, seeded.conversationId)));

    const requestId = (await mainDb.query(
      `insert into pilot.shadow_data_deletion_requests (request_id, organization_id, account_id)
       values (gen_random_uuid(), $1, $2) returning request_id`,
      [ORG, PARENT],
    )).rows[0].request_id as string;

    const queued = (await listShadowDataDeletionRequests(adminActor, 'pending'))
      .find((row) => row.requestId === requestId);
    expect(queued?.conversationsPending).toBe(2);
    expect(queued?.conversationsHeld).toBe(2);

    // Another gym's admin cannot reach it.
    await expect(completeShadowDataDeletionRequest(otherAdminActor, requestId))
      .rejects.toThrow('SHADOW_DELETION_REQUEST_NOT_ACTIONABLE');

    const outcome = await completeShadowDataDeletionRequest(adminActor, requestId);
    expect(outcome).toMatchObject({ requestId, status: 'completed', conversationsCleared: 2, conversationsHeld: 2 });

    const tokens: string[] = [];
    for (const cleared of [aboutChild, deletedEarlier]) {
      await expectOldIdsGone(mainDb, cleared);
      const keptId = await keptCopy(mainDb, cleared);
      const messages = await messagesOf(mainDb, keptId!);
      expect(messages.map((message) => message.role)).toEqual(['assistant']);
      expect(messages[0].account_id).toMatch(TOKEN);
      expectNoNames(messages[0].content, ['Dana', 'Pike', 'Jordan', 'Morgan', 'Quill']);
      tokens.push(messages[0].account_id);
    }
    expect((await messagesOf(mainDb, (await keptCopy(mainDb, aboutChild))!))[0].content)
      .toContain('Ask the coach about headgear');
    // Each cleared chat has its own token: two kept chats do not read as one person's.
    expect(new Set(tokens).size).toBe(2);

    const heldAfter = await Promise.all([flagged, escalated].map((seeded) => snapshot(mainDb, seeded.conversationId)));
    for (const [index, held] of [flagged, escalated].entries()) {
      const was = heldBefore[index] as { messages: unknown; reviews: unknown; escalations: unknown };
      const now = heldAfter[index] as typeof was;
      expect(now.messages).toEqual(was.messages);
      expect(now.reviews).toEqual(was.reviews);
      expect(now.escalations).toEqual(was.escalations);
      const session = await sessionRow(mainDb, held.conversationId);
      expect(session?.account_id).toBe(PARENT);
      expect(session?.deleted_at).not.toBeNull();
    }

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
    await expectOldIdsGone(mainDb, target);
    expect(await keptCopy(mainDb, target)).toBeNull();
  });
});

describe('T6 and T7: the retention script ends the two-year hold, on APPLY only', () => {
  test('member-deleted flagged chats past two years and member-deleted chats from before this change are cleared; nothing else is', async () => {
    activeClient = sweepDb;
    const expired = await seedConversation(sweepDb, {
      organizationId: ORG, accountId: OTHER_MEMBER, role: 'athlete', flagged: true, deletedAgo: '25 months',
      userWords: 'other.kid here, I am scared', replyWords: 'other.kid, please tell the office today.',
    });
    const expiredEscalated = await seedConversation(sweepDb, {
      organizationId: ORG, accountId: MEMBER, role: 'athlete', athleteId: ATHLETE, escalated: true, deletedAgo: '25 months',
    });
    const stillHeld = await seedConversation(sweepDb, {
      organizationId: ORG, accountId: OTHER_MEMBER, role: 'athlete', flagged: true, deletedAgo: '23 months',
    });
    const stillEscalated = await seedConversation(sweepDb, {
      organizationId: ORG, accountId: MEMBER, role: 'athlete', escalated: true, deletedAgo: '23 months',
    });
    const legacy = await seedConversation(sweepDb, {
      organizationId: ORG, accountId: MEMBER, role: 'athlete', deletedAgo: '3 days',
    });
    const live = await seedConversation(sweepDb, { organizationId: ORG, accountId: MEMBER, role: 'athlete' });
    // Flagged, past two years, and no name on record: nothing can be
    // scrubbed, so the chat goes whole; its review entry stays, under a new
    // id and a token, without the chat.
    const namelessFlagged = await seedConversation(sweepDb, {
      organizationId: ORG, accountId: NAMELESS, role: 'athlete', flagged: true, deletedAgo: '25 months',
      userWords: 'question', replyWords: 'answer',
    });
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
    // The office read the flagged exchange while it was held: the audit row
    // records the conversation, the messages and the review entry by id.
    const read = await loadHumanReviewExchange({
      organizationId: ORG, reviewId: expired.reviewId!, reader: { accountId: ADMIN, role: 'organization_admin' },
    });
    expect(read).toMatchObject({ recorded: true });

    const untouched = [stillHeld, stillEscalated, live, athleteMark, athleteOwn, deletedPerson];
    const untouchedBefore = await Promise.all(untouched.map((seeded) => snapshot(sweepDb, seeded.conversationId)));
    const due = [expired, expiredEscalated, legacy, namelessFlagged];
    const dueBefore = await Promise.all(due.map((seeded) => snapshot(sweepDb, seeded.conversationId)));

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
    expect(nightly.member_deleted_chats_due).toBe(4);
    expect(nightly.inquiries).toBe(1);
    expect(await Promise.all(due.map((seeded) => snapshot(sweepDb, seeded.conversationId)))).toEqual(dueBefore);
    const dry = await runCleanup(SWEEP_DB_NAME, 'dry');
    expect(dry.member_deleted_chats_due).toBe(4);
    expect(dry.would_clear_member_deleted_chats).toBe(4);
    expect(await Promise.all(due.map((seeded) => snapshot(sweepDb, seeded.conversationId)))).toEqual(dueBefore);

    const applied = await runCleanup(SWEEP_DB_NAME, 'apply');
    expect(applied.member_deleted_chats_cleared).toBe(4);

    await expectOldIdsGone(sweepDb, namelessFlagged);
    expect(await keptCopy(sweepDb, namelessFlagged)).toBeNull();
    expect((await sweepDb.query(`select count(*)::int as n from pilot.shadow_human_review_queue where review_id = $1`,
      [namelessFlagged.reviewId])).rows[0].n).toBe(0);
    const orphanReview = (await sweepDb.query(
      `select conversation_id, deidentified_at from pilot.shadow_human_review_queue
        where account_id ~ '^anon_' and summary like 'Review entry;%' and conversation_id is null`,
    )).rows;
    expect(orphanReview).toHaveLength(1);

    for (const cleared of [expired, expiredEscalated, legacy]) {
      await expectOldIdsGone(sweepDb, cleared);
      const keptId = await keptCopy(sweepDb, cleared);
      const messages = await messagesOf(sweepDb, keptId!);
      expect(messages.map((message) => message.role)).toEqual(['assistant']);
      expect(messages[0].account_id).toMatch(TOKEN);
      const session = await sessionRow(sweepDb, keptId!);
      expect(session?.account_id).toBe(messages[0].account_id);
      expect(session?.deidentified_at).not.toBeNull();
    }
    expectNoNames((await messagesOf(sweepDb, (await keptCopy(sweepDb, expired))!))[0].content, ['other.kid']);
    for (const mine of [expiredEscalated, legacy]) {
      expectNoNames((await messagesOf(sweepDb, (await keptCopy(sweepDb, mine))!))[0].content, NAMES_OF_THE_CHILD);
    }

    // The flagged chat's review entry follows it under a new id and the
    // chat's token: it keeps its conversation and names nobody.
    const expiredKept = (await keptCopy(sweepDb, expired))!;
    const reviews = (await sweepDb.query(
      `select review_id::text as review_id, account_id, summary, metadata, deidentified_at
         from pilot.shadow_human_review_queue where conversation_id = $1`,
      [expiredKept],
    )).rows;
    expect(reviews).toHaveLength(1);
    expect(reviews[0].review_id).not.toBe(expired.reviewId);
    expect(reviews[0].account_id).toBe((await sessionRow(sweepDb, expiredKept))?.account_id);
    expect(reviews[0].deidentified_at).not.toBeNull();
    expect(reviews[0].metadata).toEqual({});
    expectNoNames(reviews[0].summary, ['other.kid']);
    expect((await sweepDb.query(`select count(*)::int as n from pilot.shadow_human_review_queue where review_id = $1`,
      [expired.reviewId])).rows[0].n).toBe(0);

    // The office's read and the escalation stay -- the safeguarding records --
    // and join nothing that is kept: every id they hold is gone.
    const audit = (await sweepDb.query(
      `select entity_id, details from pilot.audit_events
        where event_type = 'shadow_review_exchange_read' and entity_id = $1`,
      [expired.reviewId],
    )).rows;
    expect(audit).toHaveLength(1);
    const details = audit[0].details as Record<string, string | null>;
    expect(await sessionRow(sweepDb, String(details.conversationId))).toBeUndefined();
    expect((await sweepDb.query(
      `select count(*)::int as n from pilot.shadow_chat_messages where message_id::text = any($1::text[])`,
      [[details.assistantMessageId, details.userMessageId].filter(Boolean)],
    )).rows[0].n).toBe(0);
    const escalation = (await sweepDb.query(
      `select metadata->>'conversation_id' as conversation_id from pilot.safety_escalations where escalation_id = $1`,
      [expiredEscalated.escalationId],
    )).rows[0];
    expect(escalation).toBeDefined();
    expect(await sessionRow(sweepDb, escalation.conversation_id)).toBeUndefined();

    expect(await Promise.all(untouched.map((seeded) => snapshot(sweepDb, seeded.conversationId))))
      .toEqual(untouchedBefore);

    // A second APPLY finds nothing more to clear.
    const again = await runCleanup(SWEEP_DB_NAME, 'apply');
    expect(again.member_deleted_chats_cleared ?? 0).toBe(0);
  });

  test('T7: the script and the delete control leave the same rows behind', async () => {
    activeClient = sweepDb;
    const words = {
      userWords: 'Jordan Pike asks about jab drills',
      replyWords: 'Jordan, Lightning, keep the jab long. Pike out. Morgan Quill says hi.',
    };
    const byControl = await seedConversation(sweepDb, {
      organizationId: ORG, accountId: MEMBER, role: 'athlete', athleteId: ATHLETE, ...words,
    });
    await expect(deleteOwnConversation!(memberActor, byControl.conversationId)).resolves.toBe(true);
    const byScript = await seedConversation(sweepDb, {
      organizationId: ORG, accountId: MEMBER, role: 'athlete', athleteId: ATHLETE, deletedAgo: '1 day', ...words,
    });
    await runCleanup(SWEEP_DB_NAME, 'apply');

    const shape = async (seeded: SeededConversation) => {
      const keptId = (await keptCopy(sweepDb, seeded))!;
      const session = await sessionRow(sweepDb, keptId);
      const messages = await messagesOf(sweepDb, keptId);
      const links = await replyLinks(sweepDb, seeded);
      return {
        oldIdsGone: await expectOldIdsGone(sweepDb, seeded).then(() => true),
        title: session?.title,
        tokened: TOKEN.test(session?.account_id ?? ''),
        athlete: session?.athlete_id === null ? null : session?.athlete_id === session?.account_id,
        deidentified: session?.deidentified_at !== null,
        messages: messages.map((message) => ({
          role: message.role,
          content: message.content.replace(seeded.ref, '<ref>'),
          sameToken: message.account_id === session?.account_id,
        })),
        links,
      };
    };
    expect(await shape(byScript)).toEqual(await shape(byControl));
  });
});
