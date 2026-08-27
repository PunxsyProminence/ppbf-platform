// Real PostgreSQL-backed test for the research-archive gating pathway.
//
// THE CONTRACT. Custody of an original in the governed research archive
// (nonprofit SharePoint) is not approval, not verification, not indexing, and
// not citability. A document row can carry an archive pointer in `blob_path`
// while the evidence it describes remains unretrievable, and that must stay
// true no matter how the row got there.
//
// WHAT THIS FILE ADDS, AND WHY IT IS NOT A SECOND COPY OF SOMETHING.
// shadowLibraryPipeline.pg.test.ts already drives the RETRIEVAL half against a
// real database: pending evidence is not searchable, and the full approve /
// index / approve sequence makes it searchable. That is the gate seen from the
// reader's side, and it is not repeated here.
//
// Two other properties the same contract depends on had no test anywhere in
// this repository:
//
//   1. FAIL-CLOSED REGISTRATION. Registration must not be able to produce a
//      "completed" (approved + verified) source or document as a side effect.
//      If an archive write fails after a row is registered -- or, as today,
//      when no archive write happens at all -- what is left behind must be a
//      pending record, never a citable one. The database carries this as
//      shadow_library_sources_review_pair_check and
//      shadow_library_documents_review_pair_check (added by
//      pilot_slice_postgres_shadow_evidence_migration.sql). Both constraints
//      were exercised by NOTHING: no test in this repository so much as named
//      them, so a migration that dropped either would have gone green.
//
//      The document constraint is the load-bearing one for this contract. It
//      makes "approved and verified but NOT indexed" unrepresentable, which is
//      precisely the state a naive archive-custody-implies-approval shortcut
//      would try to write.
//
//   2. DUPLICATE RETRY IS IDEMPOTENT. A retried submission must not register a
//      second source or a second document. `unique (organization_id, url)` and
//      `unique (organization_id, content_sha256)` carry this, and the routes
//      turn the violation into a 409. Also untested: the 409 branches in both
//      routes had no coverage, so an exception-shape change that turned them
//      into 500s -- or, worse, a dropped unique index that let the second row
//      land -- would not have been caught.
//
// SCOPE LIMIT, STATED PLAINLY. This proves the DATABASE half. It does not and
// cannot prove that a SharePoint write failed, because NO SHADOW
// RESEARCH-REGISTRATION PATH CURRENTLY PERFORMS A GOVERNED RESEARCH ARCHIVE
// WRITE. Nothing on the registration path performs an archive write whose
// failure could be observed, so the archive-side assertion ("no second
// original") is out of reach from here; see the accompanying report.
//
// Corrected 2026-08-24. This paragraph used to say
// "src/server/document-intake/sharepoint.ts has no caller", which was simply
// false: app/api/document-ingest/route.ts imports uploadToSharePoint and calls
// it. That helper is the GENERIC intake uploader, writing to a configurable
// destination (SHAREPOINT_FOLDER_PATH, defaulting to PPBF/Intake) -- a
// different concern from the governed Research Archive, and not a research
// authority. The scope limit survives the correction because it never rested
// on that file being dead; it rests on no RESEARCH registration path making an
// archive write. Getting the reason wrong while getting the conclusion right
// is how a limit outlives the thing that justified it.
//
// Spins up the same disposable, local-only embedded Postgres the sibling pg
// suites use (scripts/test-embedded-pg-server.mjs). It NEVER connects to
// production or staging: the database is created fresh here and torn down at
// the end of the run.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import { requirePrincipal } from './http';
import type { PilotPrincipal } from './auth';

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-research-archive-gating-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_research_archive_gating';

const ORG_ID = 'org-archive-gating';
const ACCOUNT_ID = 'acct-archive-curator';

// Base schema creates the shadow_library tables; the evidence migration adds
// approval_state / verification_state / index_completed_at AND the two
// review_pair_check constraints this file exists to exercise. The other two
// match the sibling suite so the schema under test is the same one.
const SCHEMA_FILES = [
  'pilot_slice_postgres.sql',
  // Applied because PRODUCTION HAS IT: it adds pilot.athletes.deleted_at, which
  // the authorization queries in access.ts now require. deploy-production's
  // schema check asserts every migration's `add column` exists in the live
  // database, and it passed on the 2026-08-27 release. A fixture without it
  // builds a schema nobody runs.
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_shadow_runtime_migration.sql',
  'pilot_slice_postgres_shadow_evidence_migration.sql',
  'pilot_slice_postgres_shadow_chunk_embedding_migration.sql',
  'pilot_slice_postgres_retraction_surveillance_migration.sql',
];

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

type Routes = {
  postSource: typeof import('@/app/api/pilot/shadow/library/sources/route').POST;
  postDocument: typeof import('@/app/api/pilot/shadow/library/documents/route').POST;
};

let routes: Routes;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

function principal(): PilotPrincipal {
  return {
    accountId: ACCOUNT_ID,
    role: 'organization_admin',
    organizationId: ORG_ID,
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function jsonRequest(url: string, method: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

async function rawQuery<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: connectionStringFor(TEST_DB_NAME) });
  await client.connect();
  try {
    const result = await client.query<T>(sql, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

/**
 * Runs SQL that is EXPECTED to be refused, and returns the refusal.
 *
 * Returning the error rather than asserting inside a try/catch matters: a
 * `try { await q(); fail() } catch {}` shape passes when the query throws for
 * ANY reason -- a typo'd column name refuses just as loudly as a constraint
 * does. Callers below assert on `code` and `constraint`, so a test can only go
 * green if the SPECIFIC constraint under test did the refusing.
 */
async function refusalFrom(sql: string, params: unknown[] = []): Promise<{ code?: string; constraint?: string }> {
  try {
    await rawQuery(sql, params);
  } catch (error) {
    return error as { code?: string; constraint?: string };
  }
  throw new Error(`Expected the database to refuse this statement, but it succeeded:\n${sql}`);
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
  for (const file of SCHEMA_FILES) {
    await migrateClient.query(await fs.readFile(path.join(INFRA_DIR, file), 'utf8'));
  }
  await migrateClient.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  // approved_by_account_id / verified_by_account_id are foreign keys into
  // pilot.accounts, so the reviewer has to be a real row -- otherwise the
  // "approved without indexing" case below would be refused by the FK and the
  // review_pair_check it is meant to prove would never be reached.
  await migrateClient.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ACCOUNT_ID, ORG_ID],
  );
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  routes = {
    postSource: (await import('@/app/api/pilot/shadow/library/sources/route')).POST,
    postDocument: (await import('@/app/api/pilot/shadow/library/documents/route')).POST,
  };
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

beforeEach(() => {
  mockRequirePrincipal.mockReset();
  mockRequirePrincipal.mockResolvedValue(principal());
});

interface ReviewColumns extends Record<string, unknown> {
  approval_state: string;
  verification_state: string;
  approved_by_account_id: string | null;
  approved_at: Date | null;
  verified_by_account_id: string | null;
  verified_at: Date | null;
}

async function registerSource(url: string, title = 'Governed archive original'): Promise<Response> {
  return routes.postSource(jsonRequest('/api/pilot/shadow/library/sources', 'POST', {
    title,
    publisher: 'Punxsy Prominence',
    source_type: 'peer_reviewed',
    authority_tier: 2,
    status: 'active',
    url,
  }));
}

async function registerDocument(sourceId: string, contentSha256: string, blobPath: string): Promise<Response> {
  return routes.postDocument(jsonRequest('/api/pilot/shadow/library/documents', 'POST', {
    source_id: sourceId,
    document_name: 'Archived original.pdf',
    // The archive pointer. Its presence is the whole point: a row can name a
    // custodied original and still be uncitable.
    blob_path: blobPath,
    content_sha256: contentSha256,
    ingest_state: 'chunking',
  }));
}

describe('archive custody does not confer approval (real database)', () => {
  const SOURCE_URL = 'https://example.org/governed/original-a';
  const CONTENT_SHA = 'a'.repeat(64);
  let sourceId: string;
  let documentId: string;

  test('a source registered with an archive URL is not born approved or verified', async () => {
    const response = await registerSource(SOURCE_URL);
    const payload = await response.json();
    expect(response.status).toBe(201);
    sourceId = payload.source.source_id;

    const [row] = await rawQuery<ReviewColumns>(
      `select approval_state, verification_state, approved_by_account_id, approved_at,
              verified_by_account_id, verified_at
       from pilot.shadow_library_sources where source_id = $1`,
      [sourceId],
    );

    // Registration is custody, not endorsement.
    expect(row.approval_state).toBe('pending_review');
    expect(row.verification_state).toBe('unverified');
    expect(row.approved_by_account_id).toBeNull();
    expect(row.approved_at).toBeNull();
    expect(row.verified_by_account_id).toBeNull();
    expect(row.verified_at).toBeNull();
  });

  test('a document registered against it carries the archive pointer while still pending', async () => {
    const response = await registerDocument(sourceId, CONTENT_SHA, 'SHADOW AIML/02 - Source Materials/original-a.pdf');
    const payload = await response.json();
    expect(response.status).toBe(201);
    documentId = payload.document.document_id;

    const [row] = await rawQuery<ReviewColumns & { blob_path: string | null; ingest_state: string; index_completed_at: Date | null }>(
      `select approval_state, verification_state, approved_by_account_id, approved_at,
              verified_by_account_id, verified_at, blob_path, ingest_state, index_completed_at
       from pilot.shadow_library_documents where document_id = $1`,
      [documentId],
    );

    // The archive pointer is recorded...
    expect(row.blob_path).toBe('SHADOW AIML/02 - Source Materials/original-a.pdf');
    // ...and buys the row exactly nothing.
    expect(row.approval_state).toBe('pending_review');
    expect(row.verification_state).toBe('unverified');
    expect(row.ingest_state).toBe('chunking');
    expect(row.index_completed_at).toBeNull();
  });

  // The fail-closed guarantee for behaviour 1, seen from the database rather
  // than from a route: even a direct write cannot leave a "completed" source
  // behind without a recorded human reviewer. Whatever happens to an archive
  // write, this is the state the row is confined to.
  test('the database refuses a source approved and verified with no recorded reviewer', async () => {
    const refusal = await refusalFrom(
      `update pilot.shadow_library_sources
       set approval_state = 'approved', verification_state = 'verified'
       where source_id = $1`,
      [sourceId],
    );

    expect(refusal.code).toBe('23514');
    expect(refusal.constraint).toBe('shadow_library_sources_review_pair_check');

    // And the refusal left the row alone rather than half-applying.
    const [row] = await rawQuery<ReviewColumns>(
      'select approval_state, verification_state, approved_by_account_id, approved_at, verified_by_account_id, verified_at from pilot.shadow_library_sources where source_id = $1',
      [sourceId],
    );
    expect(row.approval_state).toBe('pending_review');
    expect(row.verification_state).toBe('unverified');
  });

  // The load-bearing one. A shortcut that reasoned "the original is safely in
  // SharePoint, so the document is good" would write exactly this row: full
  // reviewer identity, approved, verified -- and never indexed. The database
  // makes that state unrepresentable, which is what stops archive custody from
  // becoming a back door around indexing.
  test('the database refuses a document approved and verified while it is not indexed', async () => {
    const refusal = await refusalFrom(
      `update pilot.shadow_library_documents
       set approval_state = 'approved',
           verification_state = 'verified',
           approved_by_account_id = $2,
           approved_at = now(),
           verified_by_account_id = $2,
           verified_at = now()
       where document_id = $1`,
      [documentId, ACCOUNT_ID],
    );

    expect(refusal.code).toBe('23514');
    expect(refusal.constraint).toBe('shadow_library_documents_review_pair_check');

    const [row] = await rawQuery<{ approval_state: string; ingest_state: string }>(
      'select approval_state, ingest_state from pilot.shadow_library_documents where document_id = $1',
      [documentId],
    );
    expect(row.approval_state).toBe('pending_review');
    expect(row.ingest_state).toBe('chunking');
  });

  // The mirror image, so the pair above cannot be satisfied by a constraint
  // that simply refuses every approval: with indexing genuinely complete and a
  // reviewer recorded, the same write is ACCEPTED. Without this, dropping
  // 'approved' from the allowed states would still leave the two tests above
  // green.
  test('the same write is accepted once indexing is genuinely complete', async () => {
    await rawQuery(
      `update pilot.shadow_library_documents
       set ingest_state = 'indexed', index_completed_at = now()
       where document_id = $1`,
      [documentId],
    );

    await rawQuery(
      `update pilot.shadow_library_documents
       set approval_state = 'approved',
           verification_state = 'verified',
           approved_by_account_id = $2,
           approved_at = now(),
           verified_by_account_id = $2,
           verified_at = now()
       where document_id = $1`,
      [documentId, ACCOUNT_ID],
    );

    const [row] = await rawQuery<{ approval_state: string; verification_state: string }>(
      'select approval_state, verification_state from pilot.shadow_library_documents where document_id = $1',
      [documentId],
    );
    expect(row.approval_state).toBe('approved');
    expect(row.verification_state).toBe('verified');
  });
});

describe('a retried submission registers nothing twice (real database)', () => {
  const SOURCE_URL = 'https://example.org/governed/original-b';
  const CONTENT_SHA = 'b'.repeat(64);
  const BLOB_PATH = 'SHADOW AIML/02 - Source Materials/original-b.pdf';
  let sourceId: string;

  test('the first submission registers one source', async () => {
    const response = await registerSource(SOURCE_URL, 'Retried archive original');
    const payload = await response.json();
    expect(response.status).toBe(201);
    sourceId = payload.source.source_id;
  });

  test('retrying the same source URL is refused and leaves exactly one source', async () => {
    const retry = await registerSource(SOURCE_URL, 'Retried archive original');
    expect(retry.status).toBe(409);

    const rows = await rawQuery<{ source_id: string }>(
      'select source_id from pilot.shadow_library_sources where organization_id = $1 and url = $2',
      [ORG_ID, SOURCE_URL],
    );
    expect(rows).toHaveLength(1);
    // Same row, not a replacement.
    expect(rows[0].source_id).toBe(sourceId);
  });

  test('the first document submission registers one document', async () => {
    const response = await registerDocument(sourceId, CONTENT_SHA, BLOB_PATH);
    expect(response.status).toBe(201);
  });

  test('retrying the same content hash is refused and leaves exactly one document', async () => {
    const retry = await registerDocument(sourceId, CONTENT_SHA, BLOB_PATH);
    expect(retry.status).toBe(409);

    const rows = await rawQuery<{ document_id: string; blob_path: string | null }>(
      'select document_id, blob_path from pilot.shadow_library_documents where organization_id = $1 and content_sha256 = $2',
      [ORG_ID, CONTENT_SHA],
    );
    expect(rows).toHaveLength(1);
    // One archive pointer, not two: the retry did not fork custody of the
    // original into a second record.
    expect(rows[0].blob_path).toBe(BLOB_PATH);
  });

  test('the refused retries left the held records pending, not promoted', async () => {
    const [source] = await rawQuery<ReviewColumns>(
      'select approval_state, verification_state, approved_by_account_id, approved_at, verified_by_account_id, verified_at from pilot.shadow_library_sources where source_id = $1',
      [sourceId],
    );
    expect(source.approval_state).toBe('pending_review');
    expect(source.verification_state).toBe('unverified');

    const [document] = await rawQuery<{ approval_state: string; verification_state: string; ingest_state: string }>(
      'select approval_state, verification_state, ingest_state from pilot.shadow_library_documents where organization_id = $1 and content_sha256 = $2',
      [ORG_ID, CONTENT_SHA],
    );
    expect(document.approval_state).toBe('pending_review');
    expect(document.verification_state).toBe('unverified');
    expect(document.ingest_state).toBe('chunking');
  });
});
