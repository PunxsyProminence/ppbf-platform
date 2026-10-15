// Real PostgreSQL proof that a Library document or chunk the retention purge
// HELD (metadata.subject_purged_at, scripts/pilot-cleanup-deleted-data.mjs)
// is never served again (F-086): not by subject search on either path, not in
// the curator queue, not approvable, not attachable to a research submission
// -- even to a NEW athlete the roster gave the purged child's id, which is the
// case the deletion mark on the old athlete row can no longer cover.
//
// './db' is mocked to route into the embedded server (the pattern of
// shadowLibraryRetrieval.pg.test.ts); './shadowEmbeddings' is mocked for
// enablement and the network call only.
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

import { Client } from 'pg';

let activeClient: Client | null = null;

function requireClient(): Client {
  if (!activeClient) throw new Error('test bug: no active embedded client');
  return activeClient;
}

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    const result = await requireClient().query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    const result = await requireClient().query(text, params);
    return result.rows[0] ?? null;
  }),
  withTransaction: jest.fn(async (fn: (client: Client) => Promise<unknown>) => fn(requireClient())),
}));
jest.mock('./shadowTelemetry', () => ({ writeShadowTelemetryEvent: jest.fn() }));
jest.mock('./shadowEmbeddings', () => ({
  ...jest.requireActual('./shadowEmbeddings'),
  isSemanticLibrarySearchEnabled: jest.fn(() => true),
  embedText: jest.fn(),
  getEmbeddingDeploymentName: jest.fn(() => 'test-embedding'),
}));

import { embedText, isSemanticLibrarySearchEnabled } from './shadowEmbeddings';
import {
  createShadowLibraryChunk,
  createShadowLibraryDocument,
  listShadowLibraryReviewQueue,
  reviewShadowLibraryDocument,
  searchShadowLibrary,
  type ShadowLibrarySearchDetail,
} from './shadowLibrary';
import { documentExistsInOrg } from './shadowResearchSubmissions';

jest.setTimeout(240_000);

const mockEmbedText = jest.mocked(embedText);
const mockSemanticEnabled = jest.mocked(isSemanticLibrarySearchEnabled);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-held-library-documents-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_held_library_documents';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-held-1';
const ADMIN = 'acct-held-admin';
// The id the purged child had, now given by the roster to a new, live child.
const REISSUED = 'ath-held-a';
const SOURCE = 'src-held-1';
const DIMENSIONS = 1536;
const MARK = JSON.stringify({ subject_purged_at: '2026-10-15T00:00:00Z' });

// The new child's own document: the only one search may serve.
const LIVE = 'doc-live';
// What the purge leaves for the old child: document and chunk marked.
const HELD = 'doc-held';
// The mark on the document alone, and on a stray chunk alone (under the gym's
// own, unmarked document): each must be enough by itself.
const DOCUMENT_MARK_ONLY = 'doc-mark-only';
const GYM_WITH_STRAY = 'doc-gym-stray';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;

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

async function servableDocument(documentId: string, subjectId: string | null, marked: boolean) {
  await requireClient().query(
    `insert into pilot.shadow_library_documents
       (document_id, source_id, organization_id, subject_id, document_name, ingest_state, index_completed_at,
        approval_state, verification_state, approved_by_account_id, approved_at, verified_by_account_id, verified_at,
        metadata)
     values ($1, $2, $3, $4, $1, 'indexed', now(), 'approved', 'verified', $5, now(), $5, now(), $6::jsonb)`,
    [documentId, SOURCE, ORG, subjectId, ADMIN, marked ? MARK : '{}'],
  );
}

/** One embedded chunk pointing along axis 0, matching the search words. */
async function embeddedChunk(chunkId: string, documentId: string, subjectId: string | null, marked: boolean) {
  await requireClient().query(
    `insert into pilot.shadow_library_chunks
       (chunk_id, document_id, source_id, organization_id, subject_id, ordinal, text_content, text_kind,
        embedding, embedding_model, metadata)
     values ($1, $2, $3, $4, $5, 0, 'southpaw footwork pivot ' || $1, 'full_text',
             (select jsonb_agg(case when i = 0 then 1::float8 else 0::float8 end order by i)
                from generate_series(0, $6 - 1) as i),
             'test-embedding', $7::jsonb)`,
    [chunkId, documentId, SOURCE, ORG, subjectId, DIMENSIONS, marked ? MARK : '{}'],
  );
}

async function subjectSearch(semantic: boolean): Promise<string[]> {
  mockSemanticEnabled.mockReturnValue(semantic);
  const detail: ShadowLibrarySearchDetail = { nearest: [], mode: 'keyword' };
  const results = await searchShadowLibrary({
    organizationId: ORG,
    actorAccountId: ADMIN,
    actorRole: 'organization_admin',
    scope: 'subject',
    subjectId: REISSUED,
    queryText: 'southpaw footwork pivot',
    limit: 8,
  }, detail);
  expect(detail.mode).toBe(semantic ? 'semantic' : 'keyword');
  return results.map((row) => row.chunk_id).sort();
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

  activeClient = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await activeClient.connect();
  const helper = await nativeDynamicImport(pathToFileURL(FULL_SCHEMA_HELPER_PATH).href);
  await (helper.applyFullSchema as (client: Client, opts?: { infraDir?: string }) => Promise<unknown>)(activeClient, {
    infraDir: INFRA_DIR,
  });

  const db = requireClient();
  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status) values ($1, 'Gym', 'active')`,
    [ORG],
  );
  await db.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft')`,
    [ADMIN, ORG],
  );
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'New Child', '2014-05-05', 'youth-50', 'active', 'Guardian', true, $3, now(), now())`,
    [ORG, REISSUED, ADMIN],
  );
  await db.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, status, rights_status,
        approval_state, verification_state, approved_by_account_id, approved_at, verified_by_account_id, verified_at)
     values ($1, $2, 'Coach observations', 'article', 1, 'active', 'ppbf_owned',
             'approved', 'verified', $3, now(), $3, now())`,
    [SOURCE, ORG, ADMIN],
  );

  await servableDocument(LIVE, REISSUED, false);
  await embeddedChunk(`${LIVE}-c0`, LIVE, REISSUED, false);
  await servableDocument(HELD, REISSUED, true);
  await embeddedChunk(`${HELD}-c0`, HELD, REISSUED, true);
  await servableDocument(DOCUMENT_MARK_ONLY, REISSUED, true);
  await embeddedChunk(`${DOCUMENT_MARK_ONLY}-c0`, DOCUMENT_MARK_ONLY, REISSUED, false);
  await servableDocument(GYM_WITH_STRAY, null, false);
  await embeddedChunk('stray-c0', GYM_WITH_STRAY, REISSUED, true);
});

afterAll(async () => {
  await activeClient?.end().catch(() => {});
  activeClient = null;
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
  mockEmbedText.mockResolvedValue(Array.from({ length: DIMENSIONS }, (_, i) => (i === 0 ? 1 : 0)));
});

describe('a Library document or chunk the retention purge held (F-086)', () => {
  test('semantic subject search for the reissued id serves only the new child\'s own chunk', async () => {
    expect(await subjectSearch(true)).toEqual([`${LIVE}-c0`]);
  });

  test('keyword subject search does the same', async () => {
    expect(await subjectSearch(false)).toEqual([`${LIVE}-c0`]);
  });

  test('the curator queue leaves the held documents out', async () => {
    const queue = await listShadowLibraryReviewQueue({ organizationId: ORG });
    const ids = queue.documents.map((row) => row.document_id).sort();
    expect(ids).toEqual([GYM_WITH_STRAY, LIVE].sort());
  });

  test('a held document cannot be approved again; a live one can', async () => {
    const review = (documentId: string) => reviewShadowLibraryDocument({
      organizationId: ORG,
      actorAccountId: ADMIN,
      actorRole: 'organization_admin',
      documentId,
      approvalState: 'approved',
      verificationState: 'verified',
    });
    await expect(review(HELD)).rejects.toThrow('SHADOW document is missing or has not completed indexing');
    await expect(review(LIVE)).resolves.toMatchObject({ document_id: LIVE });
  });

  test('a held document takes no new chunk', async () => {
    await expect(createShadowLibraryChunk({
      organizationId: ORG,
      actorAccountId: ADMIN,
      actorRole: 'organization_admin',
      documentId: HELD,
      ordinal: 1,
      textContent: 'A new note',
    })).rejects.toThrow('Document does not exist in this organization.');
    const chunks = await requireClient().query(
      'select count(*)::int as n from pilot.shadow_library_chunks where document_id = $1',
      [HELD],
    );
    expect(chunks.rows[0].n).toBe(1);
  });

  test('nobody but the purge can write the mark: a document or chunk carrying it is refused', async () => {
    await expect(createShadowLibraryDocument({
      organizationId: ORG,
      actorAccountId: ADMIN,
      actorRole: 'organization_admin',
      sourceId: SOURCE,
      documentName: 'Self-marked',
      metadata: { subject_purged_at: '2026-10-15T00:00:00Z' },
    })).rejects.toThrow('metadata.subject_purged_at is set only by the retention purge');
    await expect(createShadowLibraryChunk({
      organizationId: ORG,
      actorAccountId: ADMIN,
      actorRole: 'organization_admin',
      documentId: LIVE,
      ordinal: 9,
      textContent: 'Self-marked chunk',
      metadata: { subject_purged_at: '2026-10-15T00:00:00Z' },
    })).rejects.toThrow('metadata.subject_purged_at is set only by the retention purge');
    const rows = await requireClient().query(
      `select (select count(*) from pilot.shadow_library_documents where document_name = 'Self-marked')
            + (select count(*) from pilot.shadow_library_chunks where text_content = 'Self-marked chunk') as n`,
    );
    expect(Number(rows.rows[0].n)).toBe(0);
  });

  test('a held document cannot be attached to a research submission; a live one can', async () => {
    expect(await documentExistsInOrg(ORG, HELD)).toBe(false);
    expect(await documentExistsInOrg(ORG, LIVE)).toBe(true);
  });
});
