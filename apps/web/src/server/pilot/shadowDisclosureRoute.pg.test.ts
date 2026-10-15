// F-076 against real PostgreSQL: an athlete types a disclosure into SHADOW
// chat, and the REAL chat route, escalation ladder, coach scope
// (athleteIdsForCoach: coach of record UNION active coach_coverage) and
// escalations route decide who can read the alert.
//
// OD-2026-10-01-008 section 3 (applied to F-076 by OD-2026-10-15-002): the
// athlete's coach of record, any coach actively covering them, and admins.
// Overwatch's hard-floor exception (2026-10-15): a message naming a coach or
// other gym staff reaches admins only. OD-2026-10-10-007: SHADOW still
// answers. The research "Library gap" feed must not hold the words.
//
// './db' is routed into a disposable embedded Postgres. Mocked: the session
// lookup (requirePrincipal), the model provider (fetch), the Library evidence
// lookup, the context retrieval, the unlock evaluation, the deploy-time
// readiness probe and the replay of earlier turns, none of which this change
// touches.
// It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { Client } from 'pg';

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  ...jest.requireActual('./db'),
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
    const client = activeClient;
    await client.query('BEGIN');
    try {
      const result = await fn({ query: (text: string, values: unknown[]) => client.query(text, values) });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
  }),
}));

jest.mock('./http', () => ({
  ...jest.requireActual('./http'),
  requirePrincipal: jest.fn(),
}));

jest.mock('./azureAiRuntime', () => ({
  getAzureAiRuntimeConfig: jest.fn(() => ({
    ok: true,
    missing: [],
    config: {
      endpoint: 'https://example.invalid',
      apiKey: 'test-key',
      deploymentName: 'test-deployment',
      apiVersion: '2024-12-01-preview',
    },
  })),
  buildAzureAiChatCompletionsUrl: jest.fn(() => 'https://example.invalid/chat/completions'),
}));

// The Library holds evidence and none of it matched: the case in which #1575
// files the question as research. An empty Library would refuse the answer
// instead, and then the research guard would never be exercised.
jest.mock('./shadowEvidence', () => ({
  ...jest.requireActual('./shadowEvidence'),
  hasRetrievableLibraryEvidence: jest.fn(async () => true),
  retrieveShadowEvidenceBundle: jest.fn(async () => ({
    bundleId: null,
    availability: 'unavailable',
    items: [],
    allowedEvidenceIds: [],
    context: 'EVIDENCE UNAVAILABLE',
  })),
}));

jest.mock('./shadowChat', () => ({
  ...jest.requireActual('./shadowChat'),
  retrieveShadowContext: jest.fn(async () => ({ authorized: true, context: 'Authorized role: athlete.' })),
}));

// The deploy-time readiness probe reads the production connection setting;
// the tables it asks for are in the base schema applied below.
jest.mock('./shadowReadiness', () => ({
  assertShadowRuntimeReadiness: jest.fn(async () => undefined),
}));

// Replaying an earlier turn into the prompt reads the Library tables, which
// this change does not touch. Access checks and the stored exchange stay real.
jest.mock('./shadowConversations', () => ({
  ...jest.requireActual('./shadowConversations'),
  loadConversationMessages: jest.fn(async () => []),
}));

jest.mock('./shadowUnlocks', () => ({
  ...jest.requireActual('./shadowUnlocks'),
  evaluateShadowUnlockState: jest.fn(async () => null),
}));

import { NextRequest } from 'next/server';

import { POST as chatPOST } from '@/app/api/pilot/shadow/chat/route';
import { GET as escalationsGET } from '@/app/api/pilot/escalations/route';
import type { PilotPrincipal } from './auth';
import { requirePrincipal } from './http';

jest.setTimeout(300_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-disclosure-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG_ID = 'org-disclosure';
const ATHLETE_ID = 'ATH-DISCLOSURE-1';
const ATHLETE_ACCOUNT = 'acct-athlete-1';
const COACH_OF_RECORD = 'acct-coach-record';
const COVERING_COACH = 'acct-coach-covering';
const EXPIRED_COVER = 'acct-coach-expired';
const UNRELATED_COACH = 'acct-coach-other';
const ORG_ADMIN = 'acct-org-admin';

const ANSWER = 'You did the right thing saying it. Tell an adult you trust today.';

// Verbatim from LEADS-CHECK-2026-10-15.
const SENTENCES: ReadonlyArray<{ message: string; staff: boolean }> = [
  { message: 'My coach hits me and I am scared to go to the gym', staff: true },
  { message: 'My coach touched me and told me not to tell anyone', staff: true },
  { message: 'my coach makes me stay behind after everyone leaves', staff: true },
  { message: 'My dad hits me', staff: false },
  { message: 'I want to kill myself', staff: false },
];

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const originalFetch = global.fetch;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;

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
  await client.query(baseSchemaSql);
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active')`,
    [ORG_ID],
  );
  for (const [account, role] of [
    [COACH_OF_RECORD, 'coach'],
    [COVERING_COACH, 'coach'],
    [EXPIRED_COVER, 'coach'],
    [UNRELATED_COACH, 'coach'],
    [ORG_ADMIN, 'organization_admin'],
  ] as const) {
    await client.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
      [account, role, ORG_ID],
    );
  }
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class, gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Disclosing Athlete', '2013-05-06', 'fly', 'active', 'contact', true, $3, now(), now())`,
    [ORG_ID, ATHLETE_ID, COACH_OF_RECORD],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, athlete_id) values ($1, 'athlete', $2, 'ppbf_local', $3)`,
    [ATHLETE_ACCOUNT, ORG_ID, ATHLETE_ID],
  );
  await client.query(
    `insert into pilot.coach_coverage (organization_id, athlete_id, covering_coach_id, granted_by_account_id, starts_at, expires_at)
     values ($1, $2, $3, $4, now() - interval '1 hour', now() + interval '1 day'),
            ($1, $2, $5, $4, now() - interval '2 days', now() - interval '1 day')`,
    [ORG_ID, ATHLETE_ID, COVERING_COACH, ORG_ADMIN, EXPIRED_COVER],
  );
  return client;
}

function principal(accountId: string, role: PilotPrincipal['role'], athleteId: string | null = null): PilotPrincipal {
  return {
    accountId,
    role,
    organizationId: ORG_ID,
    athleteId,
    sessionToken: `session-${accountId}`,
    authProvider: 'ppbf_local',
  };
}

async function sendAsAthlete(message: string, conversationId?: string) {
  mockRequirePrincipal.mockResolvedValue(principal(ATHLETE_ACCOUNT, 'athlete', ATHLETE_ID));
  const fetchSpy = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ choices: [{ message: { content: ANSWER } }] }),
  });
  global.fetch = fetchSpy as unknown as typeof fetch;
  const response = await chatPOST(new NextRequest('http://localhost/api/pilot/shadow/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(conversationId ? { message, conversationId } : { message }),
  }));
  return { status: response.status, body: await response.json(), providerCalled: fetchSpy.mock.calls.length > 0 };
}

async function escalationIdsReadableBy(accountId: string, role: PilotPrincipal['role']): Promise<string[]> {
  mockRequirePrincipal.mockResolvedValue(principal(accountId, role));
  const response = await escalationsGET(new NextRequest('http://localhost/api/pilot/escalations'));
  const body = await response.json() as { ok: boolean; escalations?: Array<{ escalation_id: string }> };
  expect(body.ok).toBe(true);
  return (body.escalations ?? []).map((row) => row.escalation_id);
}

async function researchRowsText(client: Client): Promise<string> {
  const { rows } = await client.query('select row_to_json(r)::text as row from pilot.shadow_research_requirements r');
  return rows.map((row: { row: string }) => row.row).join('\n').toLowerCase();
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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  // athletes.deleted_at, read by athleteIdsForCoach and listEscalations.
  baseSchemaSql += await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_data_retention_deletion_migration.sql'), 'utf8');
  // The SHADOW chat tables' later columns (evidence tier, handoff, filter
  // reasons), as production has them.
  for (const file of [
    'pilot_slice_postgres_shadow_runtime_migration.sql',
    'pilot_slice_postgres_shadow_filter_reason_migration.sql',
  ]) {
    baseSchemaSql += await fs.readFile(path.join(INFRA_DIR, file), 'utf8');
  }
  // The CHECK this change widens, applied as production will apply it.
  baseSchemaSql += await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres_safety_escalations_migration.sql'), 'utf8');
});

afterAll(async () => {
  global.fetch = originalFetch;
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

afterEach(() => {
  activeClient = null;
});

describe('an athlete disclosure in SHADOW chat, end to end on real Postgres (F-076)', () => {
  test('each of the five files one escalation readable by exactly the ruled audience; SHADOW answers; no research row holds the words', async () => {
    const client = await freshDatabase('ppbf_test_shadow_disclosure_route');
    activeClient = client;
    try {
      // CONTROL FIRST: the research pipe is live on this database, so its
      // silence below is the guard working, not a pipe that never runs.
      const control = await sendAsAthlete('How do I throw a better jab?');
      expect(control).toMatchObject({ status: 200, body: { state: 'ok' } });
      expect(control.body.researchFiled).toBe(true);
      expect(await researchRowsText(client)).toContain('better jab');
      const afterControl = await client.query('select count(*)::int as n from pilot.safety_escalations');
      expect(afterControl.rows[0].n).toBe(0);

      for (const { message, staff } of SENTENCES) {
        // Each sentence is its own hour: the admin review row is bounded at
        // the owner's three an hour per account (OD-2026-10-01-006 s2), and
        // five disclosures from one account in a minute would spend it. The
        // escalation is not bounded by it; see the bound test below.
        await client.query(`delete from pilot.shadow_rate_limit_buckets where endpoint_key like 'safety_review%'`);
        const before = await client.query('select escalation_id from pilot.safety_escalations');
        const known = new Set(before.rows.map((row: { escalation_id: string }) => row.escalation_id));

        const sent = await sendAsAthlete(message);

        // SHADOW still answers, with nothing added.
        expect(sent).toMatchObject({ status: 200, providerCalled: true, body: { state: 'ok' } });
        expect(sent.body.response).toBe(ANSWER);
        expect(sent.body.handoff ?? null).toBeNull();
        // Told what main told them; the words are kept out (asserted below).
        expect(sent.body.researchFiled).toBe(true);

        // Exactly one new escalation, for this athlete.
        const { rows } = await client.query(
          `select escalation_id, source_type, athlete_id, escalated_to_role, reason, metadata
           from pilot.safety_escalations`,
        );
        const fresh = rows.filter((row: { escalation_id: string }) => !known.has(row.escalation_id));
        expect(fresh).toHaveLength(1);
        const [escalation] = fresh;
        expect(escalation.athlete_id).toBe(ATHLETE_ID);
        expect(escalation.source_type).toBe(staff ? 'athlete_voice' : 'shadow_disclosure');
        expect(escalation.metadata).toEqual({ channel: 'shadow_chat', conversation_id: sent.body.conversationId });
        // No words of the message in the stored row.
        const stored = JSON.stringify(escalation).toLowerCase();
        for (const word of ['hits', 'scared', 'touched', 'behind', 'leaves', 'kill', 'dad']) {
          if (message.toLowerCase().includes(word)) expect(stored).not.toContain(word);
        }

        // Who can read it.
        const id = escalation.escalation_id as string;
        expect(await escalationIdsReadableBy(ORG_ADMIN, 'organization_admin')).toContain(id);
        expect(await escalationIdsReadableBy(COACH_OF_RECORD, 'coach')).toEqual(staff ? expect.not.arrayContaining([id]) : expect.arrayContaining([id]));
        expect(await escalationIdsReadableBy(COVERING_COACH, 'coach')).toEqual(staff ? expect.not.arrayContaining([id]) : expect.arrayContaining([id]));
        expect(await escalationIdsReadableBy(EXPIRED_COVER, 'coach')).not.toContain(id);
        expect(await escalationIdsReadableBy(UNRELATED_COACH, 'coach')).not.toContain(id);

        // The admin SHADOW review row names the stored exchange.
        const reviews = await client.query(
          `select category, conversation_id from pilot.shadow_human_review_queue where conversation_id = $1`,
          [sent.body.conversationId],
        );
        expect(reviews.rows).toEqual(expect.arrayContaining([
          expect.objectContaining({ category: 'safeguarding_disclosure' }),
        ]));

        // The research feed holds none of the words.
        expect(await researchRowsText(client)).not.toContain(message.toLowerCase());
      }

      // The jab question still filed nothing.
      const total = await client.query('select count(*)::int as n from pilot.safety_escalations');
      expect(total.rows[0].n).toBe(SENTENCES.length);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  // The review row's hourly bound is the owner's and stays. The escalation
  // does not share it: a fourth disclosure in the hour still reaches the
  // ruled audience, bounded only by the chat limits.
  test('a disclosure past the review row hourly bound still files its escalation', async () => {
    const client = await freshDatabase('ppbf_test_shadow_disclosure_bound');
    activeClient = client;
    try {
      for (let i = 0; i < 4; i += 1) {
        const sent = await sendAsAthlete('My dad hits me');
        expect(sent).toMatchObject({ status: 200, body: { state: 'ok', response: ANSWER } });
      }
      const escalations = await client.query(`select count(*)::int as n from pilot.safety_escalations where source_type = 'shadow_disclosure'`);
      expect(escalations.rows[0].n).toBe(4);
      const reviews = await client.query(`select count(*)::int as n from pilot.shadow_human_review_queue where category = 'safeguarding_disclosure'`);
      expect(reviews.rows[0].n).toBe(3);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  // "my coach yells at me" then, in the same conversation, a disclosure that
  // names nobody: the coach must not receive the second one.
  test('once a conversation names gym staff, its later disclosures stay admin-only', async () => {
    const client = await freshDatabase('ppbf_test_shadow_disclosure_sticky');
    activeClient = client;
    try {
      const first = await sendAsAthlete('my coach yells at me');
      expect(first).toMatchObject({ status: 200, body: { state: 'ok' } });
      const second = await sendAsAthlete('I want to kill myself', first.body.conversationId);
      expect(second).toMatchObject({ status: 200, body: { state: 'ok', conversationId: first.body.conversationId } });

      const { rows } = await client.query(
        `select escalation_id, source_type from pilot.safety_escalations order by created_at`,
      );
      expect(rows.map((row: { source_type: string }) => row.source_type)).toEqual(['athlete_voice', 'athlete_voice']);
      const coachView = await escalationIdsReadableBy(COACH_OF_RECORD, 'coach');
      for (const row of rows) expect(coachView).not.toContain(row.escalation_id);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
