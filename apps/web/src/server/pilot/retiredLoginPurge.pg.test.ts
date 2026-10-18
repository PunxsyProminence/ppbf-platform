// Real PostgreSQL proof that the retention purge (scripts/pilot-cleanup-
// deleted-data.mjs, run as its own process) leaves no SHADOW row naming a
// purged athlete's RETIRED login, or a purged guardian's, and none of their
// typed words (F-088, the deidentify-keys migration's "PR C"; F-091; F-089).
// An athlete's login is retired, not deleted, so the account trigger the
// migration installs never fires for it. The ruling (Jason 2026-10-06):
// "delete any thing that personally Identifys the person but we keep data
// that [makes] the Ai and ML better":
// - the learning signal (shadow_learning_events,
//   shadow_recommendation_effectiveness) stays under the person's feedback
//   token, never the chat audit's;
// - their own chat sessions, messages and evidence bundles go, except a
//   conversation held for safeguarding (Q7);
// - their review entries and deletion requests stay under a token of their
//   own, the review summary replaced and its metadata cleared;
// - a feedback row still awaiting review leaves the queue with no staff
//   decision recorded.
// Another gym's rows for the same login, and a live athlete's, are untouched.
//
// Spins up the disposable local-only embedded Postgres the other suites use.
// It NEVER connects to production or staging.

import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-retired-login-purge-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_retired_login_purge';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-rl-1';
const OTHER_ORG = 'org-rl-2';
const ATHLETE_A = 'ath-rl-a'; // purged: deleted three years ago
const ATHLETE_B = 'ath-rl-b'; // live
const COACH = 'acct-rl-coach';
const LOGIN_A = 'acct-rl-athlete-a';
const LOGIN_B = 'acct-rl-athlete-b';
const GUARDIAN = 'acct-rl-guardian'; // purged: deleted 25 months ago, flagged, so past the Q7 hold

const SUMMARY_AFTER_PURGE = 'Safeguarding review entry; the person was deleted and the details removed at the retention purge.';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') {
        const { port } = address;
        server.close(() => resolve(port));
        return;
      }
      server.close(() => reject(new Error('Could not determine a free port')));
    });
  });
}

function runCleanupScript(extraEnv: Record<string, string>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    execFile(
      process.execPath,
      [CLEANUP_SCRIPT],
      {
        env: {
          ...process.env,
          AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(TEST_DB_NAME),
          PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
          PPBF_EXPECTED_POSTGRES_DATABASE: TEST_DB_NAME,
          PPBF_POSTGRES_DISABLE_SSL: 'true',
          PPBF_RETENTION_STORAGE_ACCOUNT_URL: '',
          ...extraEnv,
        },
      },
      (_error, stdout, stderr) => {
        const line = `${stdout}${stderr}`.split('\n').find((entry) => entry.trim().startsWith('{'));
        if (!line) {
          reject(new Error(`No JSON output. stdout=${stdout} stderr=${stderr}`));
          return;
        }
        resolve(JSON.parse(line) as Record<string, unknown>);
      },
    );
  });
}

/** A bundle SHADOW cited in a reply, with its item, claim and citation (keys carry the account). */
async function citeEvidence(organizationId: string, accountId: string, conversationId: string, replyId: string) {
  const bundleId = await uuid();
  const evidenceId = await uuid();
  await db.query(
    `insert into pilot.shadow_evidence_bundles (bundle_id, organization_id, account_id, query_sha256, availability, item_count)
     values ($1, $2, $3, repeat('c', 64), 'available', 1)`,
    [bundleId, organizationId, accountId],
  );
  await db.query(
    `insert into pilot.shadow_evidence_items (evidence_id, bundle_id, organization_id, account_id, source_id, document_id, chunk_id, ordinal, excerpt_sha256, library_organization_id)
     values ($1, $2, $3, $4, 'src-' || $3, 'doc-' || $3, 'chunk-' || $3, 1, repeat('d', 64), $3)`,
    [evidenceId, bundleId, organizationId, accountId],
  );
  await db.query(
    `insert into pilot.shadow_evidence_claims (claim_id, organization_id, account_id, conversation_id, assistant_message_id, bundle_id, claim_status)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, 'supported')`,
    [organizationId, accountId, conversationId, replyId, bundleId],
  );
  await db.query(
    `insert into pilot.shadow_message_citations (assistant_message_id, evidence_id, bundle_id, organization_id, account_id, ordinal)
     values ($1, $2, $3, $4, $5, 1)`,
    [replyId, evidenceId, bundleId, organizationId, accountId],
  );
}

const uuid = async () => (await db.query<{ id: string }>('select gen_random_uuid()::text as id')).rows[0].id;

interface Seeded {
  conversationId: string;
  assistantMessageId: string;
  flaggedConversationId: string;
  flaggedReplyId: string;
  feedbackId: string;
}

/**
 * One person's SHADOW rows in one gym, as the app writes them: a conversation
 * with no athlete (shadowConversations.ts resolveConversation), their turn and
 * SHADOW's reply, the evidence cited in the reply, a thumbs-down still
 * awaiting review on that reply, the learning
 * event and effectiveness row hanging off it, a deletion request, and a second
 * conversation that a safeguarding review entry flagged, whose reply names
 * them and was rated. `words` marks every place their typed words can sit.
 */
async function loginIdentity(accountId: string): Promise<Record<string, unknown>> {
  const result = await db.query(
    `select role, organization_id, athlete_id, active_flag, deleted_at is not null as deleted,
            login_email, pin_hash, password_hash, password_set_at is not null as password_set,
            microsoft_oid, microsoft_tid
       from pilot.accounts where account_id = $1`,
    [accountId],
  );
  return result.rows[0];
}

async function ringName(organizationId: string, accountId: string): Promise<string | null> {
  const result = await db.query(
    'select display_nickname from pilot.account_profiles where organization_id = $1 and account_id = $2',
    [organizationId, accountId],
  );
  return (result.rows[0]?.display_nickname as string | null | undefined) ?? null;
}

async function seedPerson(
  organizationId: string, accountId: string, role: string, words: string, name: string,
): Promise<Seeded> {
  const conversationId = await uuid();
  const userMessageId = await uuid();
  const assistantMessageId = await uuid();
  const bundleId = await uuid();
  const evidenceId = await uuid();
  await db.query(
    `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, athlete_id, title)
     values ($1, $2, $3, null, $4)`,
    [conversationId, organizationId, accountId, `${words} title`],
  );
  await db.query(
    `insert into pilot.shadow_chat_messages (message_id, conversation_id, organization_id, account_id, role, content, response_state)
     values ($1, $3, $4, $5, 'user', $6, null), ($2, $3, $4, $5, 'assistant', 'Ice it and tell your coach.', 'ok')`,
    [userMessageId, assistantMessageId, conversationId, organizationId, accountId, `${words} my wrist hurts`],
  );
  await db.query(
    `insert into pilot.shadow_evidence_bundles (bundle_id, organization_id, account_id, query_sha256, availability, item_count)
     values ($1, $2, $3, repeat('a', 64), 'available', 1)`,
    [bundleId, organizationId, accountId],
  );
  await db.query(
    `insert into pilot.shadow_evidence_items (evidence_id, bundle_id, organization_id, account_id, source_id, document_id, chunk_id, ordinal, excerpt_sha256, library_organization_id)
     values ($1, $2, $3, $4, 'src-' || $3, 'doc-' || $3, 'chunk-' || $3, 1, repeat('b', 64), $3)`,
    [evidenceId, bundleId, organizationId, accountId],
  );
  await db.query(
    `insert into pilot.shadow_evidence_claims (claim_id, organization_id, account_id, conversation_id, assistant_message_id, bundle_id, claim_status)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, 'supported')`,
    [organizationId, accountId, conversationId, assistantMessageId, bundleId],
  );
  await db.query(
    `insert into pilot.shadow_message_citations (assistant_message_id, evidence_id, bundle_id, organization_id, account_id, ordinal)
     values ($1, $2, $3, $4, $5, 1)`,
    [assistantMessageId, evidenceId, bundleId, organizationId, accountId],
  );
  const feedback = await db.query<{ feedback_id: string }>(
    `insert into pilot.shadow_feedback
       (organization_id, account_id, role, helpful, rating, comment, outcome_signal,
        correlation_type, correlation_id, recommendation_ref, verification_state, human_review_required)
     values ($1, $2, $3, false, 2, $4, 'thumbs_down', 'shadow_message', $5, $5, 'durable_client', true)
     returning feedback_id`,
    [organizationId, accountId, role, `${words} feedback`, assistantMessageId],
  );
  const feedbackId = feedback.rows[0].feedback_id;
  await db.query(
    `insert into pilot.shadow_learning_events
       (organization_id, account_id, role, feedback_id, message_id, topic, outcome_signal, effectiveness_score)
     values ($1, $2, $3, $4, $5, 'wrist', 'thumbs_down', 0.2)`,
    [organizationId, accountId, role, feedbackId, assistantMessageId],
  );
  await db.query(
    `insert into pilot.shadow_recommendation_effectiveness
       (organization_id, account_id, feedback_id, recommendation_id, recommendation_type, outcome, effectiveness_score)
     values ($1, $2, $3, $4, 'chat_answer', 'degraded', 0.2)`,
    [organizationId, accountId, feedbackId, assistantMessageId],
  );
  const flaggedConversationId = await uuid();
  const flaggedReplyId = await uuid();
  await db.query(
    `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, athlete_id, title)
     values ($1, $2, $3, null, $4)`,
    [flaggedConversationId, organizationId, accountId, `${words} flagged title`],
  );
  await db.query(
    `insert into pilot.shadow_chat_messages (message_id, conversation_id, organization_id, account_id, role, content, response_state)
     values (gen_random_uuid(), $2, $3, $4, 'user', $5, null), ($1, $2, $3, $4, 'assistant', $6, 'ok')`,
    [flaggedReplyId, flaggedConversationId, organizationId, accountId, `${words} someone hurt me`,
      `${name}, please tell your coach today.`],
  );
  await citeEvidence(organizationId, accountId, flaggedConversationId, flaggedReplyId);
  await db.query(
    `insert into pilot.shadow_feedback
       (organization_id, account_id, role, helpful, outcome_signal, correlation_type, correlation_id,
        recommendation_ref, verification_state, human_review_required)
     values ($1, $2, $3, true, 'thumbs_up', 'shadow_message', $4, $4, 'human_reviewed', false)`,
    [organizationId, accountId, role, flaggedReplyId],
  );
  // The research row the learning loop files from a rating of that reply
  // (shadowLearningLoop.ts: source_entity_id is the message id).
  await db.query(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement,
        knowledge_gap, source_status, source_confidence_tier, source_verification_state,
        created_by_account_id, created_by_role, metadata)
     values ($1, 'shadow_learning_negative_outcome', 'shadow_learning_event', $2, 'Strengthen SHADOW guidance.',
             'gap', 'weak', 'LIMITED', 'unverified', $3, $4, jsonb_build_object('topic', 'safety'))`,
    [organizationId, flaggedReplyId, accountId, role],
  );
  await db.query(
    `insert into pilot.shadow_human_review_queue (review_id, organization_id, conversation_id, account_id, category, severity, summary, metadata)
     values (gen_random_uuid(), $1, $2, $3, 'safeguarding', 'high', $4, jsonb_build_object('excerpt', $4::text))`,
    [organizationId, flaggedConversationId, accountId, `${words} review summary`],
  );
  await db.query(
    `insert into pilot.shadow_data_deletion_requests (request_id, organization_id, account_id, status)
     values (gen_random_uuid(), $1, $2, 'completed')`,
    [organizationId, accountId],
  );
  return { conversationId, assistantMessageId, feedbackId, flaggedConversationId, flaggedReplyId };
}

const LOGIN_TABLES = [
  ['shadow_chat_sessions', 'account_id'],
  ['shadow_chat_messages', 'account_id'],
  ['shadow_evidence_bundles', 'account_id'],
  ['shadow_evidence_items', 'account_id'],
  ['shadow_evidence_claims', 'account_id'],
  ['shadow_message_citations', 'account_id'],
  ['shadow_feedback', 'account_id'],
  ['shadow_learning_events', 'account_id'],
  ['shadow_recommendation_effectiveness', 'account_id'],
  ['shadow_human_review_queue', 'account_id'],
  ['shadow_data_deletion_requests', 'account_id'],
] as const;

/** Rows in one gym that still carry the login, across every SHADOW table it can sit in. */
async function loginRows(organizationId: string, accountId: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const [table, column] of LOGIN_TABLES) {
    const n = Number((await db.query(
      `select count(*) as n from pilot.${table} where organization_id = $1 and ${column} = $2`,
      [organizationId, accountId],
    )).rows[0].n);
    if (n > 0) out[table] = n;
  }
  return out;
}

/** Every place a person's typed words can sit in these tables. */
async function wordsAnywhere(needle: string): Promise<number> {
  return Number((await db.query(
    `select (select count(*) from pilot.shadow_chat_sessions where title like '%' || $1 || '%')
          + (select count(*) from pilot.shadow_chat_messages where content like '%' || $1 || '%')
          + (select count(*) from pilot.shadow_feedback where comment like '%' || $1 || '%')
          + (select count(*) from pilot.shadow_human_review_queue
              where summary like '%' || $1 || '%' or metadata::text like '%' || $1 || '%') as n`,
    [needle],
  )).rows[0].n);
}

let seededA: Seeded;
let seededB: Seeded;
let seededGuardian: Seeded;
let heldConversationId: string;
let legacyEventId: string;
let childFlaggedConversationId: string;

beforeAll(async () => {
  PG_PORT = await freePort();

  serverProcess = spawn(
    process.execPath,
    [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  ) as ChildProcessByStdio<null, Readable, Readable>;
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => {
    stderrOutput += String(chunk);
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
      reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`));
    });
  });

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB_NAME}`);
  await admin.query(`create database ${TEST_DB_NAME}`);
  await admin.end();

  db = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await db.connect();
  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>)(db, {
    infraDir: INFRA_DIR,
  });

  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'Punxsy Prominence', 'active'), ($2, 'Other Gym', 'active')`,
    [ORG, OTHER_ORG],
  );
  // The Library passage SHADOW cites in each gym (an evidence item's source key).
  for (const organizationId of [ORG, OTHER_ORG]) {
    await db.query(
      `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, rights_status)
       values ('src-' || $1, $1, 'Source', 'book', 1, 'ppbf_owned')`,
      [organizationId],
    );
    await db.query(
      `insert into pilot.shadow_library_documents (document_id, source_id, organization_id, document_name)
       values ('doc-' || $1, 'src-' || $1, $1, 'Doc')`,
      [organizationId],
    );
    await db.query(
      `insert into pilot.shadow_library_chunks (chunk_id, document_id, source_id, organization_id, ordinal, text_content)
       values ('chunk-' || $1, 'doc-' || $1, 'src-' || $1, $1, 1, 'text')`,
      [organizationId],
    );
  }
  for (const [accountId, role, athleteId] of [
    [COACH, 'coach', null],
    [LOGIN_A, 'athlete', ATHLETE_A],
    [LOGIN_B, 'athlete', ATHLETE_B],
    [GUARDIAN, 'parent', null],
  ]) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider)
       values ($1, $2, $3, $4, 'microsoft')`,
      [accountId, role, ORG, athleteId],
    );
  }
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
     values
       ($1, $2, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian', false, $4, now(), now(), now() - interval '3 years'),
       ($1, $3, 'Sam Rivera', '2011-02-09', 'youth-65', 'active', 'Guardian', true, $4, now(), now(), null)`,
    [ORG, ATHLETE_A, ATHLETE_B, COACH],
  );
  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
     values ($1, 'par-rl-g', $2, 'Gale Ortiz', '555-0100', 'g@example.test')`,
    [ORG, GUARDIAN],
  );
  await db.query(`update pilot.accounts set deleted_at = now() - interval '25 months' where account_id = $1`, [GUARDIAN]);

  seededA = await seedPerson(ORG, LOGIN_A, 'athlete', 'WORDS-A-7731', 'Rosa');
  seededB = await seedPerson(ORG, LOGIN_B, 'athlete', 'WORDS-B-2208', 'Sam');
  seededGuardian = await seedPerson(ORG, GUARDIAN, 'parent', 'WORDS-G-4419', 'Gale Ortiz');
  // A's login is also active in the other gym: its rows there are that gym's.
  await seedPerson(OTHER_ORG, LOGIN_A, 'athlete', 'WORDS-AE-3131', 'Rosa');
  // F-102: each athlete login carries every credential column and a ring
  // name, so the purge has something to clear on A's and something to leave
  // on B's. A also has a profile in the other gym, which is that gym's.
  for (const [accountId, suffix, ring] of [[LOGIN_A, 'a', 'RingAlpha'], [LOGIN_B, 'b', 'RingBravo']]) {
    await db.query(
      `update pilot.accounts
          set login_email = $2, pin_hash = $3, password_hash = $4, password_set_at = now(),
              microsoft_oid = $5, microsoft_tid = 'tid-rl'
        where account_id = $1`,
      [accountId, `rl-${suffix}@example.test`, `pin-${suffix}`, `pw-${suffix}`, `oid-${suffix}`],
    );
    await db.query(
      `insert into pilot.account_profiles (organization_id, account_id, display_nickname) values ($1, $2, $3)`,
      [ORG, accountId, ring],
    );
  }
  await db.query(
    `insert into pilot.account_profiles (organization_id, account_id, display_nickname) values ($1, $2, 'RingAlphaOther')`,
    [OTHER_ORG, LOGIN_A],
  );

  // A conversation of A's held for safeguarding (Q7: identified until two
  // years after the deletion its subject_deleted_at records), with its own
  // review entry: both stay identified, as the account trigger spares them.
  heldConversationId = await uuid();
  await db.query(
    `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, subject_deleted_at)
     values ($1, $2, $3, now() - interval '1 month')`,
    [heldConversationId, ORG, LOGIN_A],
  );
  await db.query(
    `insert into pilot.shadow_chat_messages (message_id, conversation_id, organization_id, account_id, role, content)
     values (gen_random_uuid(), $1, $2, $3, 'user', 'HELD-WORDS-5150')`,
    [heldConversationId, ORG, LOGIN_A],
  );
  await db.query(
    `insert into pilot.shadow_human_review_queue
       (review_id, organization_id, conversation_id, account_id, category, severity, summary, subject_deleted_at)
     values (gen_random_uuid(), $1, $2, $3, 'safeguarding', 'critical', 'HELD-WORDS-5150 review', now() - interval '1 month')`,
    [ORG, heldConversationId, LOGIN_A],
  );

  // A flagged conversation of A's ABOUT A (athlete_id set): it must be
  // de-identified before the athlete row goes, or that row's trigger deletes it.
  childFlaggedConversationId = await uuid();
  await db.query(
    `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, athlete_id, title)
     values ($1, $2, $3, $4, 'WORDS-AC-8080 title')`,
    [childFlaggedConversationId, ORG, LOGIN_A, ATHLETE_A],
  );
  await db.query(
    `insert into pilot.shadow_chat_messages (message_id, conversation_id, organization_id, account_id, role, content, response_state)
     values (gen_random_uuid(), $1, $2, $3, 'user', 'WORDS-AC-8080 I feel unsafe', null),
            (gen_random_uuid(), $1, $2, $3, 'assistant', 'Rosa Ortiz, you can talk to a coach you trust.', 'ok')`,
    [childFlaggedConversationId, ORG, LOGIN_A],
  );
  await db.query(
    `insert into pilot.shadow_human_review_queue (review_id, organization_id, conversation_id, account_id, category, severity, summary)
     values (gen_random_uuid(), $1, $2, $3, 'safeguarding', 'critical', 'WORDS-AC-8080 review')`,
    [ORG, childFlaggedConversationId, LOGIN_A],
  );

  // A conversation whose hold ended long ago: nothing will select A again
  // after this purge, so it goes now rather than staying identified for good.
  await db.query(
    `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, subject_deleted_at)
     values (gen_random_uuid(), $1, $2, now() - interval '3 years')`,
    [ORG, LOGIN_A],
  );

  // A legacy rating of A's that named a SHADOW event, not a message
  // (shadowFeedback.ts correlation_type 'shadow_event'), already reviewed: the
  // event id sits in its correlation_id and in the learning rows' message and
  // recommendation ids (feedback route: messageId ?? correlationId).
  legacyEventId = (await db.query<{ id: string }>(
    `insert into pilot.shadow_events (organization_id, event_name, entity_type, entity_id, actor_account_id, actor_role)
     values ($1, 'shadow_chat_response', 'shadow_chat', 'legacy', $2, 'athlete') returning shadow_event_id::text as id`,
    [ORG, LOGIN_A],
  )).rows[0].id;
  const legacyFeedback = (await db.query<{ id: string }>(
    `insert into pilot.shadow_feedback
       (organization_id, account_id, role, shadow_event_id, helpful, outcome_signal, correlation_type, correlation_id,
        verification_state, human_review_required)
     values ($1, $2, 'athlete', $3::bigint, true, 'thumbs_up', 'shadow_event', $3, 'human_reviewed', false)
     returning feedback_id::text as id`,
    [ORG, LOGIN_A, legacyEventId],
  )).rows[0].id;
  await db.query(
    `insert into pilot.shadow_learning_events
       (organization_id, account_id, role, feedback_id, shadow_event_id, message_id, outcome_signal, verification_state)
     values ($1, $2, 'athlete', $3::bigint, $4::bigint, $4, 'thumbs_up', 'human_reviewed')`,
    [ORG, LOGIN_A, legacyFeedback, legacyEventId],
  );
  await db.query(
    `insert into pilot.shadow_recommendation_effectiveness
       (organization_id, account_id, feedback_id, recommendation_id, recommendation_type, outcome)
     values ($1, $2, $3::bigint, $4, 'quick_round', 'improved')`,
    [ORG, LOGIN_A, legacyFeedback, legacyEventId],
  );

  // A turn of A's in the chat log, so the token the chat audit gives A can be
  // compared with the tokens on A's learning rows.
  await db.query(
    `insert into pilot.shadow_chat_audit (organization_id, user_id, user_role, athlete_id, user_message, shadow_response)
     values ($1, $2, 'athlete', null, 'how do I slip a jab', 'Move your head off the line.')`,
    [ORG, LOGIN_A],
  );
});

afterAll(async () => {
  await db?.end().catch(() => {});

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

// Per purged person (A in this gym, and the guardian): one unflagged
// conversation (two messages, one bundle), one flagged conversation
// (de-identified: its own message deleted, its cited bundle deleted), one
// review entry, one deletion request, one pending rating. A also has a
// flagged conversation about A (one more de-identified, one more own message,
// one more review entry), a conversation whose hold ended (deleted), and a
// legacy rating that adds a learning event and an effectiveness row (already
// reviewed, so it closes nothing). A's held conversation and its review entry
// are not counted. The guardian's rows would go with the account anyway; they
// are counted because the purge now takes them first.
const EXPECTED = {
  feedbackClosed: 2,
  learningEvents: 3,
  effectiveness: 3,
  messages: 4,
  sessions: 3,
  bundles: 4,
  reviewQueue: 3,
  deletionRequests: 2,
  flaggedConversations: 3,
  flaggedOwnMessages: 3,
};

describe("the retention purge and a purged person's remaining SHADOW rows", () => {
  test('a dry run counts what it would delete and de-identify, and changes nothing', async () => {
    const dry = await runCleanupScript({ PPBF_RETENTION_APPLY: 'false' });
    expect(dry.event).toBe('retention.cleanup.dry-run');
    expect(dry.blocked_by ?? {}).toEqual({});
    expect(dry).toMatchObject({
      would_close_shadow_feedback_reviews: EXPECTED.feedbackClosed,
      would_deidentify_shadow_learning_events: EXPECTED.learningEvents,
      would_deidentify_shadow_recommendation_effectiveness: EXPECTED.effectiveness,
      would_delete_shadow_chat_messages: EXPECTED.messages,
      would_delete_shadow_chat_sessions: EXPECTED.sessions,
      would_delete_shadow_evidence_bundles: EXPECTED.bundles,
      would_deidentify_shadow_review_queue: EXPECTED.reviewQueue,
      would_deidentify_shadow_deletion_requests: EXPECTED.deletionRequests,
      would_deidentify_shadow_flagged_conversations: EXPECTED.flaggedConversations,
      would_delete_shadow_flagged_conversation_own_messages: EXPECTED.flaggedOwnMessages,
    });
    expect(await wordsAnywhere('WORDS-A-7731')).toBe(6);
    expect(Object.keys(await loginRows(ORG, LOGIN_A))).toHaveLength(LOGIN_TABLES.length);
    expect(await loginIdentity(LOGIN_A)).toMatchObject({ login_email: 'rl-a@example.test', pin_hash: 'pin-a' });
    expect(await ringName(ORG, LOGIN_A)).toBe('RingAlpha');
  });

  test("after the purge no row in this gym carries the athlete's or the guardian's login, held rows apart", async () => {
    const event = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.blocked_by ?? {}).toEqual({});
    // Only A's held conversation, its message and its review entry still name A.
    expect(await loginRows(ORG, LOGIN_A)).toEqual({
      shadow_chat_sessions: 1,
      shadow_chat_messages: 1,
      shadow_human_review_queue: 1,
    });
    expect(event.athletes).toBe(1);
    expect(event.accounts).toBe(1);
    expect(event).toMatchObject({
      shadow_feedback_reviews_closed: EXPECTED.feedbackClosed,
      shadow_learning_events_deidentified: EXPECTED.learningEvents,
      shadow_recommendation_effectiveness_deidentified: EXPECTED.effectiveness,
      shadow_chat_messages_deleted: EXPECTED.messages,
      shadow_chat_sessions_deleted: EXPECTED.sessions,
      shadow_evidence_bundles_deleted: EXPECTED.bundles,
      shadow_review_queue_deidentified: EXPECTED.reviewQueue,
      shadow_deletion_requests_deidentified: EXPECTED.deletionRequests,
      shadow_flagged_conversations_deidentified: EXPECTED.flaggedConversations,
      shadow_flagged_conversation_own_messages_deleted: EXPECTED.flaggedOwnMessages,
    });
    const held = await db.query(
      `select (select count(*) from pilot.shadow_chat_sessions where conversation_id = $1 and account_id = $2)
            + (select count(*) from pilot.shadow_human_review_queue where conversation_id = $1 and account_id = $2) as n`,
      [heldConversationId, LOGIN_A],
    );
    expect(Number(held.rows[0].n)).toBe(2);
    expect(await loginRows(ORG, GUARDIAN)).toEqual({});
    // Neither person's typed words are left; the held conversation keeps its own.
    expect(await wordsAnywhere('WORDS-A-7731')).toBe(0);
    expect(await wordsAnywhere('WORDS-G-4419')).toBe(0);
    expect(await wordsAnywhere('HELD-WORDS-5150')).toBe(2);
  });

  test('the learning signal stays under the feedback token, never the chat audit token, with no message pointer', async () => {
    const feedback = await db.query(
      `select account_id, helpful, rating, outcome_signal from pilot.shadow_feedback where feedback_id = $1`,
      [seededA.feedbackId],
    );
    expect(feedback.rows[0]).toMatchObject({ helpful: false, rating: 2, outcome_signal: 'thumbs_down' });
    const token = feedback.rows[0].account_id as string;
    expect(token).toMatch(/^anon_/);

    const learning = await db.query(
      `select account_id, shadow_event_id, message_id, topic, outcome_signal, effectiveness_score::text as score
         from pilot.shadow_learning_events where feedback_id = $1`,
      [seededA.feedbackId],
    );
    expect(learning.rows).toEqual([{
      account_id: token, shadow_event_id: null, message_id: '', topic: 'wrist', outcome_signal: 'thumbs_down', score: '0.200',
    }]);
    const effectiveness = await db.query(
      `select account_id, recommendation_id, outcome from pilot.shadow_recommendation_effectiveness where feedback_id = $1`,
      [seededA.feedbackId],
    );
    expect(effectiveness.rows).toEqual([{ account_id: token, recommendation_id: null, outcome: 'degraded' }]);

    const chatToken = (await db.query(
      `select user_id from pilot.shadow_chat_audit where organization_id = $1 and user_role = 'athlete'`,
      [ORG],
    )).rows[0].user_id as string;
    expect(chatToken).toMatch(/^anon_/);
    expect(chatToken).not.toBe(token);

    // The guardian's learning rows are kept too, under the guardian's own token.
    const guardianLearning = await db.query(
      `select e.account_id = f.account_id as same, e.account_id like 'anon\\_%' as tokened
         from pilot.shadow_learning_events e join pilot.shadow_feedback f using (feedback_id)
        where e.feedback_id = $1`,
      [seededGuardian.feedbackId],
    );
    expect(guardianLearning.rows).toEqual([{ same: true, tokened: true }]);
    // Nothing joins the kept learning rows to a chat message any more.
    const bridge = await db.query(
      `select count(*) as n from pilot.shadow_chat_messages where message_id::text in ($1, $2)`,
      [seededA.assistantMessageId, seededGuardian.assistantMessageId],
    );
    expect(Number(bridge.rows[0].n)).toBe(0);
  });

  test("no kept feedback or learning row points at an event whose actor is the purged login (F-091)", async () => {
    const joined = await db.query(
      `select count(*) as n from pilot.shadow_events ev
        where ev.actor_account_id = $1 and ev.organization_id = $2
          and (exists (select 1 from pilot.shadow_feedback f where f.organization_id = $2 and f.account_id like 'anon\_%'
                        and (f.shadow_event_id = ev.shadow_event_id or f.correlation_id = ev.shadow_event_id::text))
            or exists (select 1 from pilot.shadow_learning_events e where e.organization_id = $2 and e.account_id like 'anon\_%'
                        and (e.shadow_event_id = ev.shadow_event_id or e.message_id = ev.shadow_event_id::text))
            or exists (select 1 from pilot.shadow_recommendation_effectiveness r where r.organization_id = $2
                        and r.account_id like 'anon\_%' and r.recommendation_id = ev.shadow_event_id::text))`,
      [LOGIN_A, ORG],
    );
    expect(Number(joined.rows[0].n)).toBe(0);
    // The legacy rating itself is kept, its signal intact, its correlation gone.
    const legacy = await db.query(
      `select account_id like 'anon\_%' as tokened, correlation_type, correlation_id, outcome_signal, verification_state
         from pilot.shadow_feedback where organization_id = $1 and correlation_type = 'shadow_event'`,
      [ORG],
    );
    expect(legacy.rows).toEqual([{
      tokened: true, correlation_type: 'shadow_event', correlation_id: null, outcome_signal: 'thumbs_up', verification_state: 'human_reviewed',
    }]);
  });

  test('feedback that was awaiting review is closed with no staff decision, not rejected', async () => {
    const rows = await db.query(
      `select verification_state, human_review_required, reviewed_by_account_id, reviewed_at
         from pilot.shadow_feedback where feedback_id in ($1, $2)`,
      [seededA.feedbackId, seededGuardian.feedbackId],
    );
    expect(rows.rows).toEqual([
      { verification_state: 'durable_client', human_review_required: false, reviewed_by_account_id: null, reviewed_at: null },
      { verification_state: 'durable_client', human_review_required: false, reviewed_by_account_id: null, reviewed_at: null },
    ]);
  });

  test("a flagged conversation is kept de-identified: their own words gone, SHADOW's reply name-scrubbed, under the review entry's token", async () => {
    // The guardian (Gale Ortiz) shares the child's surname: the child's purge,
    // first in the run, already blanked "Ortiz" in every note of the gym
    // (scrubGymNotes), and the guardian's own purge blanks "Gale".
    for (const [seeded, reply] of [
      [seededA, '[name], please tell your coach today.'],
      [seededGuardian, '[name] [name], please tell your coach today.'],
    ] as const) {
      const session = await db.query(
        `select account_id, athlete_id, title, deidentified_at is not null as stamped
           from pilot.shadow_chat_sessions where conversation_id = $1`,
        [seeded.flaggedConversationId],
      );
      expect(session.rows).toHaveLength(1);
      const token = session.rows[0].account_id as string;
      expect(token).toMatch(/^anon_/);
      expect(session.rows[0]).toMatchObject({
        athlete_id: null,
        title: 'Safeguarding-flagged conversation; de-identified at the retention purge.',
        stamped: true,
      });
      const messages = await db.query(
        `select message_id::text as id, account_id, role, content from pilot.shadow_chat_messages where conversation_id = $1`,
        [seeded.flaggedConversationId],
      );
      expect(messages.rows).toEqual([{
        id: seeded.flaggedReplyId, account_id: token, role: 'assistant', content: reply,
      }]);
      const review = await db.query(
        `select account_id from pilot.shadow_human_review_queue where conversation_id = $1`,
        [seeded.flaggedConversationId],
      );
      expect(review.rows).toEqual([{ account_id: token }]);
      // The rating of that reply keeps its signal, not the bridge to the receipt token.
      const rating = await db.query(
        `select account_id, correlation_id, recommendation_ref, outcome_signal from pilot.shadow_feedback
          where organization_id = $1 and outcome_signal = 'thumbs_up' and account_id like 'anon\_%' and correlation_type = 'shadow_message'`,
        [ORG],
      );
      expect(rating.rows).toHaveLength(2);
      for (const row of rating.rows) {
        expect(row.correlation_id).toBeNull();
        expect(row.recommendation_ref).toBeNull();
        expect(row.account_id).not.toBe(token);
      }
    }
    const evidence = await db.query(
      `select (select count(*) from pilot.shadow_evidence_claims where conversation_id = any($1::uuid[]))
            + (select count(*) from pilot.shadow_message_citations where assistant_message_id = any($2::uuid[])) as n`,
      [[seededA.flaggedConversationId, seededGuardian.flaggedConversationId], [seededA.flaggedReplyId, seededGuardian.flaggedReplyId]],
    );
    expect(Number(evidence.rows[0].n)).toBe(0);
  });

  test("a flagged conversation about the purged child survives the athlete row's trigger, de-identified", async () => {
    const session = await db.query(
      `select account_id, athlete_id, deidentified_at is not null as stamped from pilot.shadow_chat_sessions where conversation_id = $1`,
      [childFlaggedConversationId],
    );
    expect(session.rows).toHaveLength(1);
    const token = session.rows[0].account_id as string;
    expect(token).toMatch(/^anon_/);
    expect(session.rows[0]).toMatchObject({ athlete_id: token, stamped: true });
    const messages = await db.query(
      `select role, content from pilot.shadow_chat_messages where conversation_id = $1`,
      [childFlaggedConversationId],
    );
    expect(messages.rows).toEqual([{ role: 'assistant', content: '[name], you can talk to a coach you trust.' }]);
    expect(await wordsAnywhere('WORDS-AC-8080')).toBe(0);
  });

  test('no id left on a kept feedback, learning or research row matches a kept message', async () => {
    const joined = await db.query(
      `with kept as (select message_id::text as id from pilot.shadow_chat_messages where organization_id = $1)
       select (select count(*) from pilot.shadow_feedback where organization_id = $1 and account_id like 'anon\_%'
                and (correlation_id in (select id from kept) or recommendation_ref in (select id from kept)))
            + (select count(*) from pilot.shadow_learning_events where organization_id = $1 and account_id like 'anon\_%'
                and message_id in (select id from kept))
            + (select count(*) from pilot.shadow_recommendation_effectiveness where organization_id = $1
                and account_id like 'anon\_%' and recommendation_id in (select id from kept))
            + (select count(*) from pilot.shadow_research_requirements where organization_id = $1
                and created_by_account_id like 'anon\_%' and source_entity_id in (select id from kept)) as n`,
      [ORG],
    );
    expect(Number(joined.rows[0].n)).toBe(0);
    const research = await db.query(
      `select source_entity_id from pilot.shadow_research_requirements
        where organization_id = $1 and created_by_account_id like 'anon\_%' and metadata->>'topic' = 'safety'`,
      [ORG],
    );
    expect(research.rows).toHaveLength(2);
    for (const row of research.rows) expect(row.source_entity_id).toMatch(/^purged-\d+$/);
  });

  test('review entries past the hold are de-identified under their own token; deletion requests keep an anonymous receipt', async () => {
    const reviews = await db.query(
      `select account_id, category, severity, summary, metadata, deidentified_at is not null as stamped
         from pilot.shadow_human_review_queue where organization_id = $1 and account_id like 'anon\\_%'`,
      [ORG],
    );
    // A's two flagged conversations' entries and the guardian's; category and severity kept.
    expect(reviews.rows.map((row) => row.severity).sort()).toEqual(['critical', 'high', 'high']);
    for (const row of reviews.rows) {
      expect(row).toMatchObject({ category: 'safeguarding', summary: SUMMARY_AFTER_PURGE, metadata: {}, stamped: true });
    }
    const requests = await db.query(
      `select account_id, status from pilot.shadow_data_deletion_requests where organization_id = $1 and account_id like 'anon\\_%'`,
      [ORG],
    );
    expect(requests.rows).toHaveLength(2);
    for (const row of requests.rows) expect(row.status).toBe('completed');
    const receiptTokens = new Set(reviews.rows.map((row) => row.account_id as string));
    expect(receiptTokens).toEqual(new Set(requests.rows.map((row) => row.account_id as string)));
    const feedbackTokens = (await db.query(
      `select account_id from pilot.shadow_feedback where feedback_id in ($1, $2)`,
      [seededA.feedbackId, seededGuardian.feedbackId],
    )).rows.map((row) => row.account_id as string);
    for (const token of feedbackTokens) expect(receiptTokens.has(token)).toBe(false);
  });

  test("the same login's rows in another gym, and a live athlete's, are untouched", async () => {
    expect(Object.keys(await loginRows(OTHER_ORG, LOGIN_A))).toHaveLength(LOGIN_TABLES.length);
    expect(await wordsAnywhere('WORDS-AE-3131')).toBe(6);
    expect(Object.keys(await loginRows(ORG, LOGIN_B))).toHaveLength(LOGIN_TABLES.length);
    expect(await wordsAnywhere('WORDS-B-2208')).toBe(6);
    const live = await db.query(
      `select human_review_required, correlation_id from pilot.shadow_feedback where feedback_id = $1`,
      [seededB.feedbackId],
    );
    expect(live.rows).toEqual([{ human_review_required: true, correlation_id: seededB.assistantMessageId }]);
  });

  // F-102 (lane L44; OD-2026-10-08-009 D15). The retired row keeps its id,
  // role, gym and deleted_at, which sign-in refusal and the purged-child
  // filters read; nothing else on it names or signs in the child.
  test('the retired athlete login keeps only what refusing its sign-in needs; its ring name goes', async () => {
    expect(await loginIdentity(LOGIN_A)).toEqual({
      role: 'athlete',
      organization_id: ORG,
      athlete_id: null,
      active_flag: false,
      deleted: true,
      login_email: null,
      pin_hash: null,
      password_hash: null,
      password_set: false,
      microsoft_oid: null,
      microsoft_tid: null,
    });
    expect(await ringName(ORG, LOGIN_A)).toBeNull();
    // The other gym's profile of the same login is that gym's.
    expect(await ringName(OTHER_ORG, LOGIN_A)).toBe('RingAlphaOther');
    // A live athlete's login and ring name are untouched.
    expect(await loginIdentity(LOGIN_B)).toEqual({
      role: 'athlete',
      organization_id: ORG,
      athlete_id: ATHLETE_B,
      active_flag: true,
      deleted: false,
      login_email: 'rl-b@example.test',
      pin_hash: 'pin-b',
      password_hash: 'pw-b',
      password_set: true,
      microsoft_oid: 'oid-b',
      microsoft_tid: 'tid-rl',
    });
    expect(await ringName(ORG, LOGIN_B)).toBe('RingBravo');
  });

  test('the data_purged audit row carries the counts and no login or words', async () => {
    const audit = await db.query(
      `select details from pilot.audit_events where event_type = 'data_purged' order by created_at desc limit 1`,
    );
    expect(audit.rows[0].details).toMatchObject({
      shadow_feedback_reviews_closed: EXPECTED.feedbackClosed,
      shadow_learning_events_deidentified: EXPECTED.learningEvents,
      shadow_chat_messages_deleted: EXPECTED.messages,
      shadow_review_queue_deidentified: EXPECTED.reviewQueue,
    });
    const text = JSON.stringify(audit.rows[0].details);
    for (const secret of [LOGIN_A, GUARDIAN, 'WORDS-']) expect(text).not.toContain(secret);
  });
});
