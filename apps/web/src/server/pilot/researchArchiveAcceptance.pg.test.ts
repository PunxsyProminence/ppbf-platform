// The #345 acceptance chain on a real database, in one run (issue #345; lane LR2, PR B).
//
// WHY THIS FILE EXISTS. The pieces are proved one at a time: researchArchiveFiling.pg.test.ts
// (the filing module), researchArchiveGating.pg.test.ts (custody confers nothing),
// shadowLibraryPipeline.pg.test.ts (the review gate seen from search), researchLifecycle.pg.test.ts
// (a requirement from gap to resolved). No single run walked the whole chain through the ROUTES an
// app user reaches, so a break BETWEEN the pieces (a hash dropped on the way, a link not written,
// a close that quietly approved) passed every suite. This is that one run:
//
//   register a classified source
//     (0) with the four RESEARCH_ARCHIVE_* settings unset, filing is off and touches nothing
//     (1) the PDF is hashed: the recorded hash is the SHA-256 of the bytes SharePoint received
//     (2) the same bytes again are "already filed": same row, no second file, no Graph call
//     (3) the filed row carries the SharePoint identity, and the source is still unreviewed
//     (4) an excerpt linked to that original lands pending and is NOT retrievable
//     (5) source + document go through the EXISTING review gate, and only then it is retrievable
//     (6) closing a research requirement on a submission approves and resolves nothing by itself
//   plus: an unclassified source is refused, with nothing filed.
//
// WHAT IS REAL AND WHAT IS FAKED. Real: embedded Postgres with the full schema, and the route
// handlers (archive-original, sources, documents, chunks, evidence/review, research-requirements,
// research-submissions) and searchShadowLibrary. Faked: only requirePrincipal, the managed-identity
// token, and Microsoft Graph, which is reached with plain fetch (researchArchiveWrite.ts), so the
// fake is a stateful SharePoint behind global.fetch: create-only (a second PUT to a name answers
// 409 nameAlreadyExists), folder names as the live archive has them. Its URL and response shapes
// mirror researchArchiveFiling.pg.test.ts. What real SharePoint does with these requests was
// shown on 2026-10-19 (docs/SHADOW_RESEARCH_ARCHITECTURE.md section 10); this file proves the
// app's own steps. The PDF reader's hash (pdf-text/route.ts) is not run here.
// It never connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
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
jest.mock('./managedIdentityToken', () => ({
  ...jest.requireActual('./managedIdentityToken'),
  graphTokenProvider: () => async () => 'test-token',
}));

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-research-archive-acceptance-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB = 'ppbf_test_research_archive_acceptance';
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<Record<string, unknown>>;

const ORG = 'org-accept';
const ADMIN = 'acct-accept-admin';
const COACH = 'acct-accept-coach';

const SETTINGS = {
  RESEARCH_ARCHIVE_SITE_ID: 'ppbf.sharepoint.com,11111111-2222-3333-4444-555555555555,66666666-7777-8888-9999-000000000000',
  RESEARCH_ARCHIVE_DRIVE_ID: 'b!acceptanceDrive',
  RESEARCH_ARCHIVE_ROOT_ITEM_ID: 'ROOTITEM',
  RESEARCH_ARCHIVE_ORGANIZATION_IDS: ORG,
};
const BASE = `https://graph.microsoft.com/v1.0/sites/${SETTINGS.RESEARCH_ARCHIVE_SITE_ID}/drives/${SETTINGS.RESEARCH_ARCHIVE_DRIVE_ID}`;
const FOLDER_19 = 'FOLDER19';

const PDF_ONE = Buffer.from('%PDF-1.4 acceptance chain paper one, synthetic, not research');
const PDF_TWO = Buffer.from('%PDF-1.4 acceptance chain paper two, synthetic, not research');
const PDF_THREE = Buffer.from('%PDF-1.4 acceptance chain paper three, synthetic, not research');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const PASSAGE_ONE = 'Marmoset inter-rater agreement for the guarded stance checklist was substantial.';
const PASSAGE_TWO = 'Wallaroo test-retest reliability of the footwork screen was excellent.';

type Handler = (request: NextRequest) => Promise<Response>;
type Search = typeof import('./shadowLibrary').searchShadowLibrary;
const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let search: Search;
let archive: { GET: Handler; POST: Handler };
let sourcesPost: Handler;
let documentsPost: Handler;
let chunksPost: Handler;
let reviewPatch: Handler;
let requirementsPost: Handler;
let submissionsGet: Handler;
let submissionsPost: Handler;
let submissionsPatch: Handler;

// ---- the fake SharePoint: one R19 subject folder, create-only ----
const sharepoint = { files: new Map<string, { id: string; name: string; bytes: Buffer }>(), requests: [] as string[] };
const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Response;

function fakeGraph(url: string, init?: RequestInit): Response {
  const method = init?.method ?? 'GET';
  sharepoint.requests.push(`${method} ${url}`);
  const rest = url.startsWith(`${BASE}/items/`) ? url.slice(`${BASE}/items/`.length) : null;
  if (rest === null) throw new Error(`Unexpected request to ${url}`);
  const inFolder = [...sharepoint.files.values()];
  const put = /^(\w+):\/([^:]+):\/content\?@microsoft\.graph\.conflictBehavior=fail$/.exec(rest);
  if (method === 'PUT' && put?.[1] === FOLDER_19) {
    const name = decodeURIComponent(put[2]);
    if (inFolder.some((file) => file.name.toLowerCase() === name.toLowerCase())) {
      return reply(409, { error: { code: 'nameAlreadyExists', message: 'exists' } });
    }
    const file = { id: `ITEM${sharepoint.files.size + 1}`, name, bytes: Buffer.from(init?.body as Uint8Array) };
    sharepoint.files.set(file.id, file);
    return reply(201, { id: file.id, webUrl: `https://ppbf.sharepoint.com/Research%20Archive/R19/${encodeURIComponent(name)}`, parentReference: { id: FOLDER_19 } });
  }
  if (rest.startsWith('ROOTITEM/children?')) {
    return reply(200, { value: [
      { id: 'FOLDER00', name: 'R00 - Unsorted Drop', folder: {}, parentReference: { id: 'ROOTITEM' } },
      { id: FOLDER_19, name: 'R19 - Measurement and Assessment Instruments', folder: {}, parentReference: { id: 'ROOTITEM' } },
      { id: 'FOLDER98', name: 'R98 - Duplicate Hold', folder: {}, parentReference: { id: 'ROOTITEM' } },
    ] });
  }
  if (rest.startsWith(`${FOLDER_19}/children?`)) {
    return reply(200, { value: inFolder.map((file) => ({ id: file.id, name: file.name, file: {}, parentReference: { id: FOLDER_19 } })) });
  }
  throw new Error(`Unexpected ${method} ${url}`);
}

// ---- helpers ----
const connectionStringFor = (database: string) => `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;

async function sql<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: connectionStringFor(TEST_DB) });
  await client.connect();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

function as(accountId: string, role: PilotPrincipal['role']) {
  mockRequirePrincipal.mockResolvedValue({ accountId, role, organizationId: ORG, athleteId: null, sessionToken: 'token', authProvider: 'microsoft' });
}

function json(url: string, method: string, body: Record<string, unknown>) {
  return new NextRequest(`http://localhost${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function upload(sourceId: string, bytes: Buffer, filename: string) {
  const form = new FormData();
  form.append('file', new File([new Uint8Array(bytes) as unknown as BlobPart], filename, { type: 'application/pdf' }));
  for (const [name, value] of Object.entries({
    source_id: sourceId, acquisition_provider: 'Penn State University Libraries', acquisition_channel: 'library_database',
    version_kind: 'version_of_record', acquired_at: '2026-10-01',
  })) form.append(name, value);
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  return archive.POST(new NextRequest('http://localhost/api/pilot/shadow/library/archive-original', {
    method: 'POST',
    headers: { 'content-type': encoded.headers.get('content-type') ?? '', 'content-length': String(body.length) },
    body,
  }));
}

async function registerSource(title: string, classified: boolean): Promise<string> {
  const response = await sourcesPost(json('/api/pilot/shadow/library/sources', 'POST', {
    title, publisher: 'Test Journal', source_type: 'peer_reviewed', authority_tier: 2, status: 'active',
    url: `https://example.org/${title.replace(/\s+/g, '-').toLowerCase()}`,
    ...(classified ? { metadata: { classification_domain: 'measurement_assessment_instruments' } } : {}),
  }));
  expect(response.status).toBe(201);
  return (await response.json()).source.source_id as string;
}

/** An excerpt read from page 2 of the filed PDF: its document (linked) and its one part. */
async function savePdfExcerpt(sourceId: string, archivedOriginalId: string, text: string): Promise<string> {
  const created = await documentsPost(json('/api/pilot/shadow/library/documents', 'POST', {
    source_id: sourceId, document_name: 'Excerpt, page 2', archived_original_id: archivedOriginalId,
    metadata: { intake_method: 'manual_text', text_origin: 'pdf_page', locator: 'p. 2', chunk_count: 1 },
  }));
  expect(created.status).toBe(201);
  const documentId = (await created.json()).document.document_id as string;
  const part = await chunksPost(json('/api/pilot/shadow/library/chunks', 'POST', {
    document_id: documentId, ordinal: 0, text_content: text, metadata: { intake_method: 'manual_text', locator: 'p. 2', join_before: '' },
  }));
  expect(part.status).toBe(201);
  return documentId;
}

const retrievable = async (queryText: string) =>
  search({ organizationId: ORG, actorAccountId: ADMIN, actorRole: 'organization_admin', athleteId: null, scope: 'scoped', queryText });

function review(entityType: 'source' | 'document', entityId: string, body: Record<string, unknown>) {
  return reviewPatch(json('/api/pilot/shadow/evidence/review', 'PATCH', { entityType, entityId, ...body }));
}

async function reviewState(table: 'sources' | 'documents', idColumn: string, id: string) {
  const [row] = await sql<{ approval_state: string; verification_state: string; approved_by_account_id: string | null; ingest_state?: string; index_completed_at?: Date | null }>(
    `select approval_state, verification_state, approved_by_account_id${table === 'documents' ? ', ingest_state, index_completed_at' : ''}
       from pilot.shadow_library_${table} where ${idColumn} = $1`,
    [id],
  );
  return row;
}

const UNREVIEWED = { approval_state: 'pending_review', verification_state: 'unverified', approved_by_account_id: null };

beforeAll(async () => {
  PG_PORT = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => (address && typeof address === 'object' ? resolve(address.port) : reject(new Error('No free port'))));
    });
  });
  serverProcess = spawn(process.execPath, [SERVER_SCRIPT_PATH, DATA_DIR, String(PG_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrOutput = '';
  serverProcess.stderr.on('data', (chunk) => { stderrOutput += chunk.toString(); });
  await new Promise<void>((resolve, reject) => {
    const rl = readline.createInterface({ input: serverProcess.stdout });
    const timeout = setTimeout(() => { rl.close(); reject(new Error(`Embedded Postgres did not become ready. stderr:\n${stderrOutput}`)); }, 120_000);
    rl.on('line', (line) => { if (line.includes('EMBEDDED_PG_READY')) { clearTimeout(timeout); rl.close(); resolve(); } });
    serverProcess.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Embedded Postgres exited early (code ${code}). stderr:\n${stderrOutput}`)); });
  });

  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB} with (force)`);
  await admin.query(`create database ${TEST_DB}`);
  await admin.end();
  const client = new Client({ connectionString: connectionStringFor(TEST_DB) });
  await client.connect();
  try {
    const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
    await (helper.applyFullSchema as (db: Client, opts?: { infraDir?: string }) => Promise<unknown>)(client, { infraDir: INFRA_DIR });
    await client.query(`insert into pilot.organizations (organization_id, organization_name, status) values ($1, $1, 'active') on conflict do nothing`, [ORG]);
    for (const [accountId, role] of [[ADMIN, 'organization_admin'], [COACH, 'coach']]) {
      await client.query(`insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, $2, $3, 'microsoft') on conflict do nothing`, [accountId, role, ORG]);
    }
  } finally {
    await client.end();
  }

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  Object.assign(process.env, SETTINGS);
  global.fetch = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => fakeGraph(String(input), init)) as unknown as typeof fetch;

  archive = await import('@/app/api/pilot/shadow/library/archive-original/route');
  sourcesPost = (await import('@/app/api/pilot/shadow/library/sources/route')).POST;
  documentsPost = (await import('@/app/api/pilot/shadow/library/documents/route')).POST;
  chunksPost = (await import('@/app/api/pilot/shadow/library/chunks/route')).POST;
  reviewPatch = (await import('@/app/api/pilot/shadow/evidence/review/route')).PATCH;
  requirementsPost = (await import('@/app/api/pilot/shadow/research-requirements/route')).POST;
  const submissions = await import('@/app/api/pilot/shadow/research-submissions/route');
  [submissionsGet, submissionsPost, submissionsPatch] = [submissions.GET, submissions.POST, submissions.PATCH];
  search = (await import('./shadowLibrary')).searchShadowLibrary;
});

beforeEach(() => as(ADMIN, 'organization_admin'));

afterAll(async () => {
  for (const name of Object.keys(SETTINGS)) delete process.env[name];
  const { closePool } = await import('./db');
  await closePool().catch(() => {});
  await new Promise<void>((resolve) => {
    const finish = () => { clearTimeout(safetyTimer); resolve(); };
    const safetyTimer = setTimeout(finish, 15_000);
    safetyTimer.unref();
    serverProcess.once('exit', finish);
    serverProcess.kill('SIGTERM');
  });
  await fs.rm(DATA_DIR, { recursive: true, force: true }).catch(() => {});
});

// One paper walked in order: each test takes the next step and relies on the ones before it, so run
// the file whole (a -t filter leaves the later steps without their paper).
describe('the #345 acceptance chain (real database, Graph faked)', () => {
  let paperOne: string;
  let originalOne: string;
  let excerptOne: string;

  test('0. with the four RESEARCH_ARCHIVE_* settings unset, filing is off and touches nothing', async () => {
    paperOne = await registerSource('Paper One', true);
    const saved = { ...SETTINGS };
    for (const name of Object.keys(SETTINGS)) delete process.env[name];
    try {
      expect(await (await archive.GET(new NextRequest('http://localhost/api/pilot/shadow/library/archive-original'))).json()).toMatchObject({ archive: 'off' });
      const response = await upload(paperOne, PDF_ONE, 'Paper One.pdf');
      expect(response.status).toBe(503);
      expect((await response.json()).code).toBe('ARCHIVE_NOT_CONFIGURED');
    } finally {
      Object.assign(process.env, saved);
    }
    expect(sharepoint.requests).toEqual([]);
    expect(await sql('select 1 from pilot.shadow_library_archived_originals')).toEqual([]);
  });

  test('1. the PDF is hashed: the recorded hash is the SHA-256 of the bytes SharePoint received', async () => {
    expect(await (await archive.GET(new NextRequest('http://localhost/api/pilot/shadow/library/archive-original'))).json()).toMatchObject({ archive: 'on' });

    const response = await upload(paperOne, PDF_ONE, 'Paper One.pdf');
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, status: 'filed', archived_original: { source_id: paperOne, archive_domain_code: 'R19', content_sha256: sha256(PDF_ONE) } });
    originalOne = body.archived_original.archived_original_id;

    const [filed] = [...sharepoint.files.values()];
    expect(sharepoint.files.size).toBe(1);
    expect(sha256(filed.bytes)).toBe(sha256(PDF_ONE));
    expect(filed.name).toBe(`Paper One--${sha256(PDF_ONE).slice(0, 12)}.pdf`);
    expect(sharepoint.requests.filter((r) => r.startsWith('PUT '))).toHaveLength(1);
    expect(sharepoint.requests.find((r) => r.startsWith('PUT '))).toContain('conflictBehavior=fail');
  });

  test('2. the same bytes again (under another name) are "already filed": same row, no second file, no Graph call', async () => {
    const calls = sharepoint.requests.length;

    const again = await upload(paperOne, PDF_ONE, 'A renamed copy.pdf');

    expect(again.status).toBe(200);
    expect((await again.json())).toMatchObject({ status: 'already_filed', archived_original: { archived_original_id: originalOne } });
    expect(sharepoint.requests).toHaveLength(calls);
    expect(sharepoint.files.size).toBe(1);
    expect(await sql('select 1 from pilot.shadow_library_archived_originals')).toHaveLength(1);
  });

  test('3. the filed row carries the SharePoint identity, and filing left the source unreviewed', async () => {
    const [row] = await sql(
      `select provider, site_id, drive_id, item_id, web_url, archive_root_item_id, archive_domain_code, archive_filename,
              original_filename, content_sha256, byte_size::int as byte_size, acquisition_channel, created_by_account_id, source_id
         from pilot.shadow_library_archived_originals where archived_original_id = $1`,
      [originalOne],
    );
    const [filed] = [...sharepoint.files.values()];
    expect(row).toEqual({
      provider: 'sharepoint', site_id: SETTINGS.RESEARCH_ARCHIVE_SITE_ID, drive_id: SETTINGS.RESEARCH_ARCHIVE_DRIVE_ID,
      item_id: filed.id, web_url: expect.stringMatching(/^https:\/\/ppbf\.sharepoint\.com\/Research%20Archive\/R19\//),
      archive_root_item_id: 'ROOTITEM', archive_domain_code: 'R19', archive_filename: filed.name, original_filename: 'Paper One.pdf',
      content_sha256: sha256(PDF_ONE), byte_size: PDF_ONE.length, acquisition_channel: 'library_database',
      created_by_account_id: ADMIN, source_id: paperOne,
    });
    expect(await reviewState('sources', 'source_id', paperOne)).toEqual(UNREVIEWED);
  });

  test('4. an unclassified source is refused, and nothing is filed or recorded', async () => {
    const unclassified = await registerSource('Paper Three', false);
    const calls = sharepoint.requests.length;

    const response = await upload(unclassified, PDF_THREE, 'Paper Three.pdf');

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SOURCE_NOT_CLASSIFIED');
    expect(sharepoint.requests).toHaveLength(calls);
    expect(sharepoint.files.size).toBe(1);
    expect(await sql('select 1 from pilot.shadow_library_archived_originals')).toHaveLength(1);
  });

  test('5. an excerpt linked to the original is pending, and is NOT retrievable before review', async () => {
    excerptOne = await savePdfExcerpt(paperOne, originalOne, PASSAGE_ONE);

    const [row] = await sql('select archived_original_id from pilot.shadow_library_documents where document_id = $1', [excerptOne]);
    expect(row.archived_original_id).toBe(originalOne);
    expect(await reviewState('documents', 'document_id', excerptOne)).toMatchObject({ ...UNREVIEWED, index_completed_at: null });
    expect((await reviewState('documents', 'document_id', excerptOne)).ingest_state).not.toBe('indexed');
    expect(await retrievable('marmoset agreement stance')).toEqual([]);
  });

  test('6. the existing gate: source approved, document indexed, document approved; only then it is retrievable', async () => {
    expect((await review('source', paperOne, { action: 'review', approvalState: 'approved' })).status).toBe(200);
    expect(await retrievable('marmoset agreement stance')).toEqual([]);

    expect((await review('document', excerptOne, { action: 'complete_indexing' })).status).toBe(200);
    // Indexed, but nobody has approved the document: still not served.
    expect(await retrievable('marmoset agreement stance')).toEqual([]);

    expect((await review('document', excerptOne, { action: 'review', approvalState: 'approved' })).status).toBe(200);
    const served = await retrievable('marmoset agreement stance');
    expect(served).toHaveLength(1);
    expect(served[0]).toMatchObject({ document_id: excerptOne, source_id: paperOne, text_content: PASSAGE_ONE });
    const [row] = await sql('select archived_original_id from pilot.shadow_library_documents where document_id = $1', [excerptOne]);
    expect(row.archived_original_id).toBe(originalOne);
  });

  test('7. closing a requirement on a submission approves nothing and resolves nothing by itself', async () => {
    // A second paper, filed and linked, and left in review on purpose.
    const paperTwo = await registerSource('Paper Two', true);
    const filed = await upload(paperTwo, PDF_TWO, 'Paper Two.pdf');
    expect(filed.status).toBe(201);
    const excerptTwo = await savePdfExcerpt(paperTwo, (await filed.json()).archived_original.archived_original_id, PASSAGE_TWO);

    const created = await requirementsPost(json('/api/pilot/shadow/research-requirements', 'POST', {
      action: 'create', source_event_name: 'MANUAL_RESEARCH_NOTE', source_entity_type: 'manual_note', source_entity_id: 'accept-footwork',
      research_requirement: 'Is the footwork screen reliable?', knowledge_gap: 'footwork screen reliability',
    }));
    const requirementId = (await created.json()).research_requirement_id as number;
    const answerState = async () => (await (await submissionsGet(new NextRequest(
      `http://localhost/api/pilot/shadow/research-submissions?research_requirement_ids=${requirementId}`,
    ))).json()).answer_states[String(requirementId)];
    const requirementStatus = async () => (await sql<{ status: string }>(
      'select status from pilot.shadow_research_requirements where research_requirement_id = $1', [requirementId]))[0].status;

    const attached = await submissionsPost(json('/api/pilot/shadow/research-submissions', 'POST', {
      research_requirement_id: requirementId, source_id: paperTwo, document_id: excerptTwo, provenance: { provider: 'Penn State University Libraries' },
    }));
    expect(attached.status).toBe(200);
    const submissionId = (await attached.json()).item.submission_id as string;
    expect(await answerState()).toBe('sources_submitted');

    // A responsive review is not a close: the item stays open until a person closes it.
    const reviewed = await submissionsPatch(json('/api/pilot/shadow/research-submissions', 'PATCH', {
      submission_id: submissionId, applicability_state: 'responsive', review_note: 'answers the question',
    }));
    expect(reviewed.status).toBe(200);
    expect(await answerState()).toBe('partially_answered');
    expect(await requirementStatus()).toBe('open');

    as(COACH, 'coach');
    const closed = await requirementsPost(json('/api/pilot/shadow/research-requirements', 'POST', {
      action: 'resolve', research_requirement_id: requirementId, closing_submission_id: submissionId,
    }));
    expect(closed.status).toBe(200);
    expect(await requirementStatus()).toBe('resolved');
    expect(await answerState()).toBe('resolved');

    // The close approved nothing: the source and the excerpt are exactly as review left them (unreviewed),
    // and neither is served.
    expect(await reviewState('sources', 'source_id', paperTwo)).toEqual(UNREVIEWED);
    expect(await reviewState('documents', 'document_id', excerptTwo)).toMatchObject({ ...UNREVIEWED, index_completed_at: null });
    expect(await retrievable('wallaroo reliability footwork')).toEqual([]);
    // Nor did it disturb what review had approved.
    expect(await retrievable('marmoset agreement stance')).toHaveLength(1);
  });
});
