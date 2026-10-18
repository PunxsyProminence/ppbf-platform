// Real PostgreSQL-backed acceptance for lane L46 items 1 and 2 (ChatGPT
// non-video ML audit, 2026-10-17), driven through the feedback and metrics
// routes and checked in the RECORDS, not only the HTTP answer.
//
// Item 1, feedback processing completes once. Each learning table in turn is
// made to fail (a trigger that raises on it; the profiles table carries both
// the facts and the communication style), the approval is
// retried after the trigger is dropped, and the rows must show every effect
// exactly once: one observation in remembered facts, one flag count, one
// research requirement, the learning log, the reviewed effectiveness row and
// the 'complete' mark. On main the approval answered 200 whenever the
// learning log existed, and a retry after a failed log counted the fact
// again.
//
// Item 2, edited feedback propagates. A rating edited before review
// (editable until reviewed, owner decision 2026-07-31) must leave the
// feedback row, the topic's review flag and the metrics route's concern list
// in agreement, without the edit counting as a second observation.
//
// Disposable, local-only embedded Postgres. It NEVER connects to production
// or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';
import { NextRequest } from 'next/server';

// Routes every pilot query into the embedded database. Declared before the
// imports so jest's mock hoisting sees it.
let activeClient: Client | null = null;

jest.mock('./db', () => {
  const actual = jest.requireActual('./db');
  return {
    ...actual,
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
  };
});

// The routes take their principal from here; the rest of the module stays real.
jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('./shadowReadiness', () => ({
  assertShadowRuntimeReadiness: jest.fn(async () => undefined),
}));
jest.mock('./shadowRateLimit', () => {
  const actual = jest.requireActual('./shadowRateLimit');
  return { ...actual, enforceShadowRateLimit: jest.fn(async () => undefined) };
});

import { PATCH as feedbackPATCH, POST as feedbackPOST } from '@/app/api/pilot/shadow/feedback/route';
import { GET as metricsGET } from '@/app/api/pilot/shadow/metrics/route';

import type { PilotPrincipal } from './auth';
import { requirePrincipal } from './http';
import { processLearningSignal } from './shadowLearningLoop';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-learning-integrity-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG_ID = 'org-l46';
const ATHLETE = 'acct-l46-athlete';
const OTHER_ATHLETE = 'acct-l46-athlete-2';
const ADMIN = 'acct-l46-admin';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let client: Client;
const mockRequirePrincipal = requirePrincipal as jest.Mock;

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

function as(accountId: string, role: PilotPrincipal['role']): void {
  mockRequirePrincipal.mockResolvedValue({
    accountId,
    role,
    organizationId: ORG_ID,
    athleteId: null,
    sessionToken: 'session-token',
    authProvider: 'ppbf_local',
  } satisfies PilotPrincipal);
}

/** One assistant answer on its own topic, in its own live conversation. */
async function seedAnswer(topic: string, accountId = ATHLETE): Promise<string> {
  const conversationId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  await client.query(
    `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id, title, session_type)
     values ($1, $2, $3, 'Rated conversation', 'quick_round')`,
    [conversationId, ORG_ID, accountId],
  );
  await client.query(
    `insert into pilot.shadow_chat_messages
       (message_id, conversation_id, organization_id, account_id, role, content, response_state, topic, session_type)
     values ($1, $2, $3, $4, 'assistant', 'Keep your hands up.', 'ok', $5, 'quick_round')`,
    [messageId, conversationId, ORG_ID, accountId, topic],
  );
  return messageId;
}

async function rate(messageId: string, helpful: boolean, accountId = ATHLETE, comment?: string) {
  as(accountId, 'athlete');
  const response = await feedbackPOST(new NextRequest('http://localhost/api/pilot/shadow/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message_id: messageId, helpful, ...(comment ? { comment } : {}) }),
  }));
  const body = await response.json() as { feedbackId: number; learning: { accepted: boolean; reason: string } };
  expect(response.status).toBe(200);
  return body;
}

async function approve(feedbackId: number) {
  as(ADMIN, 'organization_admin');
  const response = await feedbackPATCH(new NextRequest('http://localhost/api/pilot/shadow/feedback', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ feedbackId, decision: 'approve' }),
  }));
  return { status: response.status, body: await response.json() as { ok: boolean; retryable?: boolean } };
}

async function concernedTopics(): Promise<string[]> {
  as(ADMIN, 'organization_admin');
  const response = await metricsGET(new NextRequest('http://localhost/api/pilot/shadow/metrics'));
  expect(response.status).toBe(200);
  const body = await response.json() as { metrics: { effectiveness: { concernedTopics: string[] } } };
  return body.metrics.effectiveness.concernedTopics;
}

/** Make every insert or update on one table fail until `heal`. */
async function breakTable(table: string): Promise<void> {
  await client.query(`create trigger l46_injected_failure before insert or update on pilot.${table}
                      for each row execute function pilot.l46_injected_failure()`);
}
async function heal(table: string): Promise<void> {
  await client.query(`drop trigger if exists l46_injected_failure on pilot.${table}`);
}

async function effectsOf(feedbackId: number): Promise<string[]> {
  const { rows } = await client.query<{ learning_effects_done: string[] }>(
    'select learning_effects_done from pilot.shadow_feedback where feedback_id = $1',
    [feedbackId],
  );
  return [...rows[0].learning_effects_done].sort();
}

async function observationsOf(key: string): Promise<number | null> {
  const { rows } = await client.query<{ remembered_facts: Array<{ key: string; observationCount?: number }> }>(
    'select remembered_facts from pilot.shadow_user_profiles where account_id = $1 and organization_id = $2',
    [ATHLETE, ORG_ID],
  );
  const fact = rows[0].remembered_facts.find((candidate) => candidate.key === key);
  return fact ? (fact.observationCount ?? 1) : null;
}

type FlagRow = { flag_count: number; feedback_id: string | null; review_state: string; proposed_action: string | null };
async function flagOf(topic: string): Promise<FlagRow | null> {
  const { rows } = await client.query<FlagRow>(
    `select flag_count, feedback_id, review_state, proposed_action from pilot.shadow_library_review_flags
     where organization_id = $1 and topic = $2`,
    [ORG_ID, topic],
  );
  return rows[0] ?? null;
}

async function countOf(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await client.query<{ count: string }>(sql, params);
  return Number(rows[0].count);
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
  await admin.query('drop database if exists ppbf_test_learning_integrity');
  await admin.query('create database ppbf_test_learning_integrity');
  await admin.end();

  client = new Client({ connectionString: connectionStringFor('ppbf_test_learning_integrity') });
  await client.connect();
  const fullSchema = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (fullSchema.applyFullSchema as (c: Client, o: { infraDir: string }) => Promise<unknown>)(client, { infraDir: INFRA_DIR });

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG_ID],
  );
  for (const [accountId, role] of [[ATHLETE, 'athlete'], [OTHER_ATHLETE, 'athlete'], [ADMIN, 'organization_admin']]) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
      [accountId, role, ORG_ID],
    );
  }
  await client.query(
    `insert into pilot.shadow_user_profiles (account_id, organization_id, role) values ($1, $2, 'athlete')`,
    [ATHLETE, ORG_ID],
  );
  // Personalization on from the first approval, so facts apply; the other
  // features keep their defaults (observation / disabled).
  await client.query(
    `insert into pilot.shadow_feature_thresholds
       (organization_id, feature_key, metric_key, min_value, activation_mode, description,
        created_by_account_id, updated_by_account_id)
     values ($1, 'strong_personalization', 'user_high_quality_interactions', 0, 'enabled', 'test', $2, $2)`,
    [ORG_ID, ADMIN],
  );
  await client.query(`create function pilot.l46_injected_failure() returns trigger language plpgsql as $$
                      begin raise exception 'L46_INJECTED_FAILURE'; end $$`);
  activeClient = client;
});

afterAll(async () => {
  activeClient = null;
  await client?.end().catch(() => {});
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

describe('item 1: an approval completes once, whichever write fails', () => {
  test('a failed fact write is a retryable 503, and the retry counts the fact once', async () => {
    const { feedbackId } = await rate(await seedAnswer('defense'), true);
    await breakTable('shadow_user_profiles');
    try {
      const failed = await approve(feedbackId);
      expect(failed.status).toBe(503);
      expect(failed.body.retryable).toBe(true);
      expect(await observationsOf('engaged_topic_defense')).toBeNull();
      expect(await effectsOf(feedbackId)).toEqual([]);
    } finally {
      await heal('shadow_user_profiles');
    }

    expect((await approve(feedbackId)).status).toBe(200);
    expect(await observationsOf('engaged_topic_defense')).toBe(1);
    expect(await effectsOf(feedbackId)).toEqual(['complete', 'facts']);

    // Already complete: answered from the mark, nothing replayed.
    expect((await approve(feedbackId)).status).toBe(200);
    expect(await observationsOf('engaged_topic_defense')).toBe(1);
  });

  test('a failed learning log is retryable, and the retry does not count the fact again', async () => {
    const { feedbackId } = await rate(await seedAnswer('footwork'), true);
    await breakTable('shadow_learning_events');
    try {
      expect((await approve(feedbackId)).status).toBe(503);
      // The fact committed with its mark before the log failed.
      expect(await observationsOf('engaged_topic_footwork')).toBe(1);
      expect(await effectsOf(feedbackId)).toEqual(['facts']);
    } finally {
      await heal('shadow_learning_events');
    }

    expect((await approve(feedbackId)).status).toBe(200);
    expect(await observationsOf('engaged_topic_footwork')).toBe(1);
    expect(await countOf(
      `select count(*) from pilot.shadow_learning_events where feedback_id = $1 and verification_state = 'human_reviewed'`,
      [feedbackId],
    )).toBe(1);
    expect(await effectsOf(feedbackId)).toEqual(['complete', 'facts']);
  });

  test('a failed research requirement is retryable, and the retry writes it without re-counting the flag', async () => {
    const { feedbackId } = await rate(await seedAnswer('clinch'), false);
    expect((await flagOf('clinch'))?.flag_count).toBe(1);
    await breakTable('shadow_research_requirements');
    try {
      expect((await approve(feedbackId)).status).toBe(503);
    } finally {
      await heal('shadow_research_requirements');
    }

    expect((await approve(feedbackId)).status).toBe(200);
    expect(await countOf(
      `select count(*) from pilot.shadow_research_requirements
       where organization_id = $1 and source_event_name = 'shadow_learning_negative_outcome'
         and (metadata->>'topic') = 'clinch'`,
      [ORG_ID],
    )).toBe(1);
    expect((await flagOf('clinch'))?.flag_count).toBe(1);
    expect(await effectsOf(feedbackId)).toEqual(['complete', 'library_flag']);
  });

  test('a failed approval flag, retried after another flag landed on the topic, counts this feedback once', async () => {
    const { feedbackId } = await rate(await seedAnswer('ringcraft'), false);
    await breakTable('shadow_library_review_flags');
    try {
      expect((await approve(feedbackId)).status).toBe(503);
    } finally {
      await heal('shadow_library_review_flags');
    }
    // A second person's thumbs-down on the same topic, between the attempts.
    await rate(await seedAnswer('ringcraft', OTHER_ATHLETE), false, OTHER_ATHLETE);
    expect((await flagOf('ringcraft'))?.flag_count).toBe(2);

    expect((await approve(feedbackId)).status).toBe(200);
    expect((await flagOf('ringcraft'))?.flag_count).toBe(2);
  });

  test('a failed reviewed-effectiveness write is retryable, and the retry records it', async () => {
    const { feedbackId } = await rate(await seedAnswer('conditioning'), true);
    await breakTable('shadow_recommendation_effectiveness');
    try {
      expect((await approve(feedbackId)).status).toBe(503);
    } finally {
      await heal('shadow_recommendation_effectiveness');
    }

    expect((await approve(feedbackId)).status).toBe(200);
    expect(await countOf(
      `select count(*) from pilot.shadow_recommendation_effectiveness
       where feedback_id = $1 and verification_state = 'human_reviewed'`,
      [feedbackId],
    )).toBe(1);
    expect(await observationsOf('engaged_topic_conditioning')).toBe(1);
  });
});

describe('item 2: an edit before review is reflected everywhere, once', () => {
  test('helpful -> unhelpful flags the topic and lists it as a concern', async () => {
    const messageId = await seedAnswer('jab');
    const first = await rate(messageId, true);
    expect(await flagOf('jab')).toBeNull();

    const edit = await rate(messageId, false, ATHLETE, 'Missed my question');
    expect(edit.feedbackId).toBe(first.feedbackId);
    expect(edit.learning).toMatchObject({ accepted: true, reason: 'FEEDBACK_UPDATED_PENDING_REVIEW' });

    const { rows } = await client.query<{ helpful: boolean; outcome_signal: string }>(
      'select helpful, outcome_signal from pilot.shadow_feedback where feedback_id = $1',
      [first.feedbackId],
    );
    expect(rows[0]).toEqual({ helpful: false, outcome_signal: 'thumbs_down' });
    expect(await flagOf('jab')).toMatchObject({ flag_count: 1, review_state: 'pending' });
    expect(await concernedTopics()).toContain('jab');
    const effectiveness = await client.query<{ outcome: string }>(
      `select outcome from pilot.shadow_recommendation_effectiveness where feedback_id = $1`,
      [first.feedbackId],
    );
    expect(effectiveness.rows).toEqual([{ outcome: 'degraded' }]);
  });

  test('unhelpful -> helpful withdraws the flag and drops the concern', async () => {
    const messageId = await seedAnswer('hook');
    const first = await rate(messageId, false, ATHLETE, 'Too long');
    expect(await flagOf('hook')).toMatchObject({ flag_count: 1 });
    expect(await concernedTopics()).toContain('hook');

    await rate(messageId, true);

    expect(await flagOf('hook')).toBeNull();
    expect(await concernedTopics()).not.toContain('hook');
    expect(await effectsOf(first.feedbackId)).toEqual([]);
    const effectiveness = await client.query<{ outcome: string }>(
      `select outcome from pilot.shadow_recommendation_effectiveness where feedback_id = $1`,
      [first.feedbackId],
    );
    expect(effectiveness.rows).toEqual([{ outcome: 'improved' }]);
  });

  test('toggling while another flag lands on the topic counts each feedback once, approval included', async () => {
    const mine = await seedAnswer('uppercut');
    const theirs = await seedAnswer('uppercut', OTHER_ATHLETE);
    const { feedbackId } = await rate(mine, false);
    await rate(theirs, false, OTHER_ATHLETE);
    expect((await flagOf('uppercut'))?.flag_count).toBe(2);

    await rate(mine, true);
    expect((await flagOf('uppercut'))?.flag_count).toBe(1);
    expect(await concernedTopics()).toContain('uppercut');

    await rate(mine, false);
    expect((await flagOf('uppercut'))?.flag_count).toBe(2);

    expect((await approve(feedbackId)).status).toBe(200);
    expect((await flagOf('uppercut'))?.flag_count).toBe(2);
    expect(await concernedTopics()).toContain('uppercut');
  });
});

// Review of #1738 (reviewer 1): a repeat must never be a new observation, a
// flag nothing supports must go, a proposal is counted once across retries,
// and a projection follows the row it locked.
describe('repeats, withdrawals and races', () => {
  test('a resubmitted rating and its approval never reopen a flag a curator resolved', async () => {
    const messageId = await seedAnswer('slip');
    const { feedbackId } = await rate(messageId, false, ATHLETE, 'Too vague');
    await client.query(
      `update pilot.shadow_library_review_flags set review_state = 'resolved', reviewed_at = now()
       where organization_id = $1 and topic = 'slip'`,
      [ORG_ID],
    );

    await rate(messageId, false, ATHLETE, 'Still too vague');
    expect(await flagOf('slip')).toMatchObject({ flag_count: 1, review_state: 'resolved' });
    expect(await concernedTopics()).not.toContain('slip');

    expect((await approve(feedbackId)).status).toBe(200);
    expect(await flagOf('slip')).toMatchObject({ flag_count: 1, review_state: 'resolved' });
    expect(await concernedTopics()).not.toContain('slip');
  });

  test('a flag goes when its last supporting feedback is withdrawn, whoever the row names', async () => {
    const mine = await seedAnswer('bob');
    const theirs = await seedAnswer('bob', OTHER_ATHLETE);
    await rate(mine, false);
    await rate(theirs, false, OTHER_ATHLETE);
    await rate(theirs, true, OTHER_ATHLETE);
    expect(await flagOf('bob')).toMatchObject({ flag_count: 1, feedback_id: null });

    await rate(mine, true);
    expect(await flagOf('bob')).toBeNull();
    expect(await concernedTopics()).not.toContain('bob');
  });

  test('with Library proposals on, a retried approval counts its proposal once', async () => {
    await client.query(
      `insert into pilot.shadow_feature_thresholds
         (organization_id, feature_key, metric_key, min_value, activation_mode, description,
          created_by_account_id, updated_by_account_id)
       values ($1, 'auto_library_updates', 'org_recommendation_outcomes', 0, 'enabled', 'test', $2, $2)`,
      [ORG_ID, ADMIN],
    );
    try {
      const { feedbackId } = await rate(await seedAnswer('parry'), true);
      await breakTable('shadow_learning_events');
      try {
        expect((await approve(feedbackId)).status).toBe(503);
      } finally {
        await heal('shadow_learning_events');
      }
      expect(await flagOf('parry')).toMatchObject({ flag_count: 1, proposed_action: 'promote' });

      expect((await approve(feedbackId)).status).toBe(200);
      expect(await flagOf('parry')).toMatchObject({ flag_count: 1, proposed_action: 'promote' });
      expect(await effectsOf(feedbackId)).toEqual(['complete', 'facts', 'library_flag']);
    } finally {
      await client.query(
        `delete from pilot.shadow_feature_thresholds where organization_id = $1 and feature_key = 'auto_library_updates'`,
        [ORG_ID],
      );
    }
  });

  // Reviewer 2: the approval used to add +1 whenever another feedback had
  // flagged the topic after this one, so a client flag and its own approval
  // counted the same feedback twice.
  test('a client flag and its own approval count one feedback once when another flag landed between', async () => {
    const mine = await seedAnswer('cover');
    const { feedbackId } = await rate(mine, false);
    await rate(await seedAnswer('cover', OTHER_ATHLETE), false, OTHER_ATHLETE);
    expect((await flagOf('cover'))?.flag_count).toBe(2);

    expect((await approve(feedbackId)).status).toBe(200);
    expect((await flagOf('cover'))?.flag_count).toBe(2);
  });

  test('a client projection follows the row it locks, not the value a slower request carried', async () => {
    const { feedbackId } = await rate(await seedAnswer('weave'), true);
    // The earlier tap of a quick down-then-up, arriving last.
    await processLearningSignal({
      feedbackId,
      messageId: crypto.randomUUID(),
      userId: ATHLETE,
      organizationId: ORG_ID,
      role: 'athlete',
      topic: 'weave',
      sessionType: 'quick_round',
      outcome: 'thumbs_down',
      verificationState: 'durable_client',
    });
    expect(await flagOf('weave')).toBeNull();
    expect(await concernedTopics()).not.toContain('weave');
  });
});
