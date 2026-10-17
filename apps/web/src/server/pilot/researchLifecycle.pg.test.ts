// Real PostgreSQL proof that one research item travels the whole lifecycle
// (issue #345; #1467) through the REAL routes, each step taken by the role
// that owns it; only requirePrincipal is stubbed:
//
//   gap filed -> coach attaches an existing Library source -> organization
//   admin reviews it -> partially answered -> responsive -> closed on that
//   submission -> resolved, read back by the family of the child it is about.
//
// Rulings pinned here: OD-2026-10-08-005 A-Q13 (a close needs a closing note or
// an approved submission; a coach may attach); N6-02-Q1 A ("approved" means
// reviewed responsive); OD-2026-10-02-015 D6 (a submission never resolves a
// requirement by itself); OD-2026-10-06-003 / -010 (staff close; the family
// reads a question about their own child). Closing a requirement is not Library
// approval: the attached source stays as /evidence left it.
//
// Spins up the disposable local-only embedded Postgres the other suites use.
// It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import type { PilotPrincipal } from './auth';
import { requirePrincipal } from './http';

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-research-lifecycle-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_research_lifecycle';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

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

const ORG = 'org-lc-1';
const ATHLETE = 'ath-lc-1';

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let requirementsGet: (request: NextRequest) => Promise<Response>;
let requirementsPost: (request: NextRequest) => Promise<Response>;
let submissionsGet: (request: NextRequest) => Promise<Response>;
let submissionsPost: (request: NextRequest) => Promise<Response>;
let submissionsPatch: (request: NextRequest) => Promise<Response>;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

function principal(accountId: string, role: PilotPrincipal['role'], athleteId: string | null = null): PilotPrincipal {
  return { accountId, role, organizationId: ORG, athleteId, sessionToken: 'token', authProvider: 'microsoft' } as PilotPrincipal;
}

const AS = {
  admin: () => principal('acct-lc-admin', 'organization_admin'),
  coach: () => principal('acct-lc-coach', 'coach'),
  parent: () => principal('acct-lc-parent', 'parent'),
  athlete: () => principal('acct-lc-athlete', 'athlete', ATHLETE),
};

const URL_REQUIREMENTS = 'http://localhost/api/pilot/shadow/research-requirements';
const URL_SUBMISSIONS = 'http://localhost/api/pilot/shadow/research-submissions';

function jsonRequest(url: string, method: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function as<T>(actor: PilotPrincipal, call: () => Promise<T>): Promise<T> {
  mockRequirePrincipal.mockResolvedValue(actor);
  return call();
}

async function answerState(requirementId: number): Promise<string> {
  const response = await as(AS.coach(), () => submissionsGet(new NextRequest(
    `${URL_SUBMISSIONS}?research_requirement_ids=${requirementId}`,
  )));
  expect(response.status).toBe(200);
  const body = (await response.json()) as { answer_states: Record<string, string> };
  return body.answer_states[String(requirementId)];
}

async function review(submissionId: string, verdict: string, actor = AS.admin()): Promise<Response> {
  return as(actor, () => submissionsPatch(jsonRequest(URL_SUBMISSIONS, 'PATCH', {
    submission_id: submissionId, applicability_state: verdict, review_note: `marked ${verdict}`,
  })));
}

async function close(requirementId: number, body: Record<string, unknown>, actor = AS.admin()): Promise<Response> {
  return as(actor, () => requirementsPost(jsonRequest(URL_REQUIREMENTS, 'POST', {
    action: 'resolve', research_requirement_id: requirementId, ...body,
  })));
}

async function storedRequirement(requirementId: number) {
  const row = await db.query<{ status: string; metadata: Record<string, unknown> }>(
    'select status, metadata from pilot.shadow_research_requirements where research_requirement_id = $1',
    [requirementId],
  );
  return row.rows[0];
}

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

  const adminClient = new Client({ connectionString: connectionStringFor('postgres') });
  await adminClient.connect();
  await adminClient.query(`drop database if exists ${TEST_DB_NAME}`);
  await adminClient.query(`create database ${TEST_DB_NAME}`);
  await adminClient.end();

  db = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await db.connect();
  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>)(db, {
    infraDir: INFRA_DIR,
  });

  await db.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, 'Punxsy Prominence', 'active')`, [ORG]);
  for (const [accountId, role, athleteId] of [
    ['acct-lc-admin', 'organization_admin', null],
    ['acct-lc-coach', 'coach', null],
    ['acct-lc-parent', 'parent', null],
    ['acct-lc-athlete', 'athlete', ATHLETE],
  ]) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, athlete_id, auth_provider) values ($1, $2, $3, $4, 'microsoft')`,
      [accountId, role, ORG, athleteId],
    );
  }
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian', true, 'acct-lc-coach', now(), now())`,
    [ORG, ATHLETE],
  );
  await db.query(
    `insert into pilot.parents (organization_id, parent_id, account_id, full_name, phone, email)
     values ($1, 'par-lc', 'acct-lc-parent', 'Guardian', '555-0100', 'guardian@example.test')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.guardian_links (organization_id, parent_id, athlete_id, relationship_to_athlete)
     values ($1, 'par-lc', $2, 'mother')`,
    [ORG, ATHLETE],
  );
  // Two Library sources, registered and still pending evidence review.
  await db.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, status, created_by_account_id, created_by_role)
     values ('src-lc-partial', $1, 'RPE in adults', 'peer_reviewed', 2, 'active', 'acct-lc-admin', 'organization_admin'),
            ('src-lc-answer', $1, 'RPE reliability in adolescents', 'peer_reviewed', 2, 'active', 'acct-lc-admin', 'organization_admin')`,
    [ORG],
  );

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  const requirements = await import('@/app/api/pilot/shadow/research-requirements/route');
  requirementsGet = requirements.GET;
  requirementsPost = requirements.POST;
  const submissions = await import('@/app/api/pilot/shadow/research-submissions/route');
  submissionsGet = submissions.GET;
  submissionsPost = submissions.POST;
  submissionsPatch = submissions.PATCH;
});

afterAll(async () => {
  const { closePool } = await import('./db');
  await closePool().catch(() => {});
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

// One item, walked in order: each test takes the next step.
describe('one research item from gap to resolved (#345, #1467)', () => {
  let requirementId: number;
  let partialSubmissionId: string;
  let answerSubmissionId: string;

  test('1. a coach files the gap about a child; it reads Needs Evidence', async () => {
    const response = await as(AS.coach(), () => requirementsPost(jsonRequest(URL_REQUIREMENTS, 'POST', {
      action: 'create',
      source_event_name: 'MANUAL_RESEARCH_NOTE',
      source_entity_type: 'manual_note',
      source_entity_id: 'lc-rpe-12',
      subject_id: ATHLETE,
      research_requirement: 'Is RPE reliable at age 12?',
      knowledge_gap: 'adolescent RPE reliability',
    })));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { research_requirement_id: number };
    expect(typeof body.research_requirement_id).toBe('number');
    requirementId = body.research_requirement_id;
    expect(await answerState(requirementId)).toBe('needs_evidence');
  });

  test('2. a coach attaches two existing sources; they land unreviewed and the item reads Sources Submitted', async () => {
    for (const sourceId of ['src-lc-partial', 'src-lc-answer']) {
      const response = await as(AS.coach(), () => submissionsPost(jsonRequest(URL_SUBMISSIONS, 'POST', {
        research_requirement_id: requirementId, source_id: sourceId, provenance: { provider: 'Penn State Library' },
      })));
      expect(response.status).toBe(200);
    }
    const rows = await db.query<{ submission_id: string; source_id: string; applicability_state: string }>(
      'select submission_id, source_id, applicability_state from pilot.shadow_research_submissions where research_requirement_id = $1',
      [requirementId],
    );
    expect(rows.rows.map((row) => row.applicability_state)).toEqual(['unreviewed', 'unreviewed']);
    partialSubmissionId = rows.rows.find((row) => row.source_id === 'src-lc-partial')!.submission_id;
    answerSubmissionId = rows.rows.find((row) => row.source_id === 'src-lc-answer')!.submission_id;
    expect(await answerState(requirementId)).toBe('sources_submitted');
    expect((await storedRequirement(requirementId)).status).toBe('open');
  });

  test('3. an unreviewed submission cannot close it, and a coach cannot review', async () => {
    const closeResponse = await close(requirementId, { closing_submission_id: answerSubmissionId }, AS.coach());
    expect(closeResponse.status).toBe(400);
    expect((await review(answerSubmissionId, 'responsive', AS.coach())).status).toBe(403);
    expect((await storedRequirement(requirementId)).status).toBe('open');
  });

  test('4. the admin reviews one as partially responsive: Partially Answered, and that one cannot close it', async () => {
    expect((await review(partialSubmissionId, 'partially_responsive')).status).toBe(200);
    expect(await answerState(requirementId)).toBe('partially_answered');
    expect((await close(requirementId, { closing_submission_id: partialSubmissionId })).status).toBe(400);
    expect((await storedRequirement(requirementId)).status).toBe('open');
  });

  test('5. a close with neither a note nor a submission is refused', async () => {
    expect((await close(requirementId, {})).status).toBe(400);
    expect((await close(requirementId, { closing_note: '   ' })).status).toBe(400);
  });

  test('6. the admin reviews the other as responsive; the item is still open until a person closes it', async () => {
    expect((await review(answerSubmissionId, 'responsive')).status).toBe(200);
    expect(await answerState(requirementId)).toBe('partially_answered');
    expect((await storedRequirement(requirementId)).status).toBe('open');
  });

  test('7. the parent of the child reads the item but cannot close it', async () => {
    const list = await as(AS.parent(), () => requirementsGet(new NextRequest(`${URL_REQUIREMENTS}?limit=50`)));
    expect(list.status).toBe(200);
    const items = ((await list.json()) as { items: Array<{ research_requirement_id: number | string; status: string }> }).items;
    expect(items.map((item) => Number(item.research_requirement_id))).toContain(requirementId);
    expect((await close(requirementId, { closing_submission_id: answerSubmissionId }, AS.parent())).status).toBe(403);
    expect((await storedRequirement(requirementId)).status).toBe('open');
  });

  test('8. a coach closes it on the responsive submission; it reads Resolved and records which one', async () => {
    const response = await close(requirementId, { closing_submission_id: answerSubmissionId }, AS.coach());
    expect(response.status).toBe(200);
    const stored = await storedRequirement(requirementId);
    expect(stored.status).toBe('resolved');
    expect(stored.metadata).toEqual(expect.objectContaining({
      closing_submission_id: answerSubmissionId,
      resolved_by_account_id: 'acct-lc-coach',
      closing_note: null,
    }));
    expect(await answerState(requirementId)).toBe('resolved');
  });

  test('9. closing it approved nothing in the Library: both sources stay as evidence review left them', async () => {
    const sources = await db.query<{ source_id: string; approval_state: string; verification_state: string }>(
      `select source_id, approval_state, verification_state from pilot.shadow_library_sources
        where organization_id = $1 order by source_id`,
      [ORG],
    );
    expect(sources.rows).toEqual([
      { source_id: 'src-lc-answer', approval_state: 'pending_review', verification_state: 'unverified' },
      { source_id: 'src-lc-partial', approval_state: 'pending_review', verification_state: 'unverified' },
    ]);
  });

  test('10. the family reads it resolved; a second close finds nothing open', async () => {
    for (const actor of [AS.parent(), AS.athlete()]) {
      const list = await as(actor, () => requirementsGet(new NextRequest(`${URL_REQUIREMENTS}?limit=50`)));
      const items = ((await list.json()) as { items: Array<{ research_requirement_id: number | string; status: string }> }).items;
      const mine = items.find((item) => Number(item.research_requirement_id) === requirementId);
      expect(mine?.status).toBe('resolved');
    }
    expect((await close(requirementId, { closing_note: 'again' }, AS.coach())).status).toBe(404);
    expect((await storedRequirement(requirementId)).metadata.closing_note).toBeNull();
  });
});
