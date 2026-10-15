// Real PostgreSQL proof that a coach attaches an existing Library source to a
// research requirement (OD-2026-10-08-005 A-Q13, ruling 6: "a coach may
// attach a source"), through the REAL route handlers with the real access
// gates; only requirePrincipal is stubbed. Rules under test:
//   - a coach reads the gym shelf's source list, but cannot register a source;
//   - a coach's link lands 'unreviewed', and a coach cannot review it, so
//     attaching is never approval and never closes the requirement;
//   - a coach attaches only to a question they may read (the reach gate;
//     here, not one about a deleted athlete), and attaches a source, not a
//     document;
//   - a parent does neither.
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-coach-attach-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_coach_attach';

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

const ORG = 'org-ca-1';
const MINE = 'ath-ca-mine';
const OTHER = 'ath-ca-other';
const GONE = 'ath-ca-gone';

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let submissionsPost: (request: NextRequest) => Promise<Response>;
let submissionsPatch: (request: NextRequest) => Promise<Response>;
let sourcesGet: (request: NextRequest) => Promise<Response>;
let sourcesPost: (request: NextRequest) => Promise<Response>;
const ids: { aboutMine?: number; aboutOther?: number; aboutNobody?: number; aboutGone?: number } = {};

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

function principal(accountId: string, role: PilotPrincipal['role']): PilotPrincipal {
  return { accountId, role, organizationId: ORG, athleteId: null, sessionToken: 'token', authProvider: 'microsoft' } as PilotPrincipal;
}

const COACH = () => principal('acct-ca-coach', 'coach');
const ADMIN = () => principal('acct-ca-admin', 'organization_admin');
const PARENT = () => principal('acct-ca-parent', 'parent');

function jsonRequest(url: string, method: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function attachAs(actor: PilotPrincipal, body: Record<string, unknown>): Promise<Response> {
  mockRequirePrincipal.mockResolvedValue(actor);
  return submissionsPost(jsonRequest('http://localhost/api/pilot/shadow/research-submissions', 'POST', body));
}

async function storedSubmissions(requirementId: number) {
  const rows = await db.query<{ applicability_state: string; submitted_by_account_id: string; document_id: string | null }>(
    `select applicability_state, submitted_by_account_id, document_id from pilot.shadow_research_submissions
      where organization_id = $1 and research_requirement_id = $2`,
    [ORG, requirementId],
  );
  return rows.rows;
}

async function insertRequirement(entityId: string, subjectId: string | null): Promise<number> {
  const row = await db.query<{ id: string }>(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement,
        knowledge_gap, source_status, source_confidence_tier, source_verification_state,
        created_by_account_id, created_by_role, metadata, subject_id)
     values ($1, 'MANUAL_RESEARCH_NOTE', 'manual_note', $2, $3, 'gap', 'missing', 'INSUFFICIENT', 'unknown',
             'acct-ca-admin', 'organization_admin', $4::jsonb, $5)
     returning research_requirement_id::text as id`,
    [ORG, entityId, `requirement ${entityId}`, JSON.stringify(subjectId ? { athlete_id: subjectId } : {}), subjectId],
  );
  return Number(row.rows[0].id);
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

  await db.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, 'Punxsy Prominence', 'active')`, [ORG]);
  for (const [accountId, role] of [
    ['acct-ca-admin', 'organization_admin'],
    ['acct-ca-coach', 'coach'],
    ['acct-ca-coach-2', 'coach'],
    ['acct-ca-parent', 'parent'],
  ]) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft')`,
      [accountId, role, ORG],
    );
  }
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values
       ($1, $2, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian', true, 'acct-ca-coach', now(), now()),
       ($1, $3, 'Sam Rivera', '2011-02-09', 'youth-65', 'active', 'Guardian', true, 'acct-ca-coach-2', now(), now()),
       ($1, $4, 'Lee Park', '2010-05-01', 'youth-70', 'active', 'Guardian', true, 'acct-ca-coach', now(), now())`,
    [ORG, MINE, OTHER, GONE],
  );
  await db.query(`update pilot.athletes set deleted_at = now() where organization_id = $1 and athlete_id = $2`, [ORG, GONE]);
  await db.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, status, created_by_account_id, created_by_role)
     values ('src-ca-1', $1, 'RPE reliability in adolescents', 'peer_reviewed', 2, 'active', 'acct-ca-admin', 'organization_admin'),
            ('src-ca-2', $1, 'Footwork drill order', 'peer_reviewed', 2, 'active', 'acct-ca-admin', 'organization_admin')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.shadow_library_documents (document_id, source_id, organization_id, document_name)
     values ('doc-ca-2', 'src-ca-2', $1, 'footwork.pdf')`,
    [ORG],
  );
  ids.aboutMine = await insertRequirement('about-mine', MINE);
  ids.aboutOther = await insertRequirement('about-other', OTHER);
  ids.aboutNobody = await insertRequirement('about-nobody', null);
  ids.aboutGone = await insertRequirement('about-gone', GONE);

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  const submissions = await import('@/app/api/pilot/shadow/research-submissions/route');
  submissionsPost = submissions.POST;
  submissionsPatch = submissions.PATCH;
  const sources = await import('@/app/api/pilot/shadow/library/sources/route');
  sourcesGet = sources.GET;
  sourcesPost = sources.POST;
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

describe('a coach attaches an existing Library source (OD-2026-10-08-005 A-Q13)', () => {
  test('a coach reads the source list to pick from', async () => {
    mockRequirePrincipal.mockResolvedValue(COACH());
    const response = await sourcesGet(new NextRequest('http://localhost/api/pilot/shadow/library/sources'));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<{ source_id: string }> };
    expect(body.items.map((item) => item.source_id).sort()).toEqual(['src-ca-1', 'src-ca-2']);
  });

  test('a coach cannot register a new source', async () => {
    mockRequirePrincipal.mockResolvedValue(COACH());
    const response = await sourcesPost(jsonRequest('http://localhost/api/pilot/shadow/library/sources', 'POST', {
      title: 'A coach source', source_type: 'peer_reviewed', authority_tier: 2,
    }));
    expect(response.status).toBe(403);
    const count = await db.query(`select count(*)::int as n from pilot.shadow_library_sources where organization_id = $1`, [ORG]);
    expect(count.rows[0].n).toBe(2);
  });

  test('a coach attaches a source to a question about their athlete; it lands unreviewed under the coach', async () => {
    const response = await attachAs(COACH(), { research_requirement_id: ids.aboutMine, source_id: 'src-ca-1' });
    expect(response.status).toBe(200);
    expect(await storedSubmissions(ids.aboutMine!)).toEqual([
      { applicability_state: 'unreviewed', submitted_by_account_id: 'acct-ca-coach', document_id: null },
    ]);
  });

  test('a coach attaches to the gym question that names nobody', async () => {
    expect((await attachAs(COACH(), { research_requirement_id: ids.aboutNobody, source_id: 'src-ca-1' })).status).toBe(200);
    expect(await storedSubmissions(ids.aboutNobody!)).toHaveLength(1);
  });

  // A coach reaches the whole gym (#1480, access.ts), so the reach check
  // refuses what that gate refuses: here, a question about a deleted athlete.
  test('a question about an athlete the coach cannot reach is a not-found, and nothing is written', async () => {
    const response = await attachAs(COACH(), { research_requirement_id: ids.aboutGone, source_id: 'src-ca-1' });
    expect(response.status).toBe(404);
    expect(await storedSubmissions(ids.aboutGone!)).toEqual([]);
  });

  test('a coach cannot link a document; the organization admin can', async () => {
    const coach = await attachAs(COACH(), { research_requirement_id: ids.aboutOther, source_id: 'src-ca-2', document_id: 'doc-ca-2' });
    expect(coach.status).toBe(403);
    expect(await storedSubmissions(ids.aboutOther!)).toEqual([]);
    const admin = await attachAs(ADMIN(), { research_requirement_id: ids.aboutOther, source_id: 'src-ca-2', document_id: 'doc-ca-2' });
    expect(admin.status).toBe(200);
  });

  test("a coach cannot review the link: attaching is never approval", async () => {
    const [submission] = (await db.query<{ submission_id: string }>(
      `select submission_id from pilot.shadow_research_submissions where organization_id = $1 and research_requirement_id = $2`,
      [ORG, ids.aboutMine],
    )).rows;
    mockRequirePrincipal.mockResolvedValue(COACH());
    const response = await submissionsPatch(jsonRequest('http://localhost/api/pilot/shadow/research-submissions', 'PATCH', {
      submission_id: submission.submission_id, applicability_state: 'responsive',
    }));
    expect(response.status).toBe(403);
    expect((await storedSubmissions(ids.aboutMine!))[0].applicability_state).toBe('unreviewed');
    const requirement = await db.query(`select status from pilot.shadow_research_requirements where research_requirement_id = $1`, [ids.aboutMine]);
    expect(requirement.rows[0].status).toBe('open');
  });

  test('a parent can neither read the source list nor attach', async () => {
    mockRequirePrincipal.mockResolvedValue(PARENT());
    expect((await sourcesGet(new NextRequest('http://localhost/api/pilot/shadow/library/sources'))).status).toBe(403);
    expect((await attachAs(PARENT(), { research_requirement_id: ids.aboutNobody, source_id: 'src-ca-1' })).status).toBe(403);
  });
});
