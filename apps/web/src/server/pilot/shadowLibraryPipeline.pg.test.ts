// Real PostgreSQL-backed test for the SHADOW Library write path.
//
// The audit in #36 found that the Library could not be populated at all: the
// four endpoints seed:shadow:library POSTs to did not exist, so no source, no
// document and no chunk could ever be written. searchShadowLibrary therefore
// always returned zero rows, deriveEvidenceTier always saw zero citations, and
// the four-tier evidence shading on every answer was decorative.
//
// Unit tests with a mocked shadowLibrary module can show that the new routes
// call the right functions, but they cannot show that a seeded document is
// actually retrievable afterwards -- that depends on real SQL, on the review
// gate, and on the several state columns searchShadowLibrary requires. This
// test drives the whole cascade against a real database instead:
//
//   register source -> register document -> register chunks
//     -> search finds nothing (nothing is approved yet)
//     -> approve source, complete indexing, approve document
//     -> search finds the chunk
//
// Spins up the same disposable, local-only embedded Postgres instance the
// session-expiry suite uses (scripts/test-embedded-pg-server.mjs). It NEVER
// connects to production or staging: the database is created fresh here and
// the instance is torn down at the end of the run.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-library-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_shadow_library';

const ORG_ID = 'org-library-test';
const ACCOUNT_ID = 'acct-curator';
const OTHER_ORG_ID = 'org-library-other';
const OTHER_ACCOUNT_ID = 'acct-curator-other';

// The base schema creates the four shadow_library tables; the evidence
// migration adds the approval/verification/index_completed_at columns that the
// review gate and searchShadowLibrary both depend on. The retraction
// surveillance migration adds retrieval_suppressed, which searchShadowLibrary
// also excludes on -- see its own "not coalesce(s.retrieval_suppressed, false)"
// predicate. That column dependency is the same shape as approval_state's:
// deploying the code before the migration would 42703 on every search, so the
// runbook (apply-migrations.yml) applies migrations before the code that
// depends on them, same as it always has.
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
  getSources: typeof import('@/app/api/pilot/shadow/library/sources/route').GET;
  postDocument: typeof import('@/app/api/pilot/shadow/library/documents/route').POST;
  postChunk: typeof import('@/app/api/pilot/shadow/library/chunks/route').POST;
  postCoverage: typeof import('@/app/api/pilot/shadow/library/capability-coverage/route').POST;
  patchReview: typeof import('@/app/api/pilot/shadow/evidence/review/route').PATCH;
  searchShadowLibrary: typeof import('./shadowLibrary').searchShadowLibrary;
};

let routes: Routes;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

function principal(role: PilotPrincipal['role'] = 'organization_admin'): PilotPrincipal {
  return {
    accountId: ACCOUNT_ID,
    role,
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
  for (const org of [ORG_ID, OTHER_ORG_ID]) {
    await migrateClient.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [org],
    );
  }
  // The evidence migration declares approved_by_account_id / verified_by_account_id
  // as foreign keys into pilot.accounts, so the reviewer has to be a real row
  // or every approval fails on the constraint rather than on its own logic.
  for (const [accountId, org] of [[ACCOUNT_ID, ORG_ID], [OTHER_ACCOUNT_ID, OTHER_ORG_ID]]) {
    await migrateClient.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
      [accountId, org],
    );
  }
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  // db.ts only honors this when NODE_ENV is exactly 'test' (Jest sets it), so
  // production and staging can never take this path.
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  // Imported only after the connection string is in place, so the app's lazily
  // constructed pool targets this disposable database.
  routes = {
    postSource: (await import('@/app/api/pilot/shadow/library/sources/route')).POST,
    getSources: (await import('@/app/api/pilot/shadow/library/sources/route')).GET,
    postDocument: (await import('@/app/api/pilot/shadow/library/documents/route')).POST,
    postChunk: (await import('@/app/api/pilot/shadow/library/chunks/route')).POST,
    postCoverage: (await import('@/app/api/pilot/shadow/library/capability-coverage/route')).POST,
    patchReview: (await import('@/app/api/pilot/shadow/evidence/review/route')).PATCH,
    searchShadowLibrary: (await import('./shadowLibrary')).searchShadowLibrary,
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

async function search(queryText: string) {
  return routes.searchShadowLibrary({
    organizationId: ORG_ID,
    actorAccountId: ACCOUNT_ID,
    actorRole: 'organization_admin',
    athleteId: null,
    scope: 'scoped',
    queryText,
  });
}

describe('SHADOW Library write path (real database)', () => {
  // Mirrors seed-shadow-library.mjs step for step, including the doctrine text
  // it chunks, so a change that breaks the seed script breaks this first.
  const DOCTRINE = 'SHADOW must never assert a clinical conclusion without cited evidence from an approved source.';
  let sourceId: string;
  let documentId: string;

  test('step 2: registers a doctrine source', async () => {
    const response = await routes.postSource(jsonRequest('/api/pilot/shadow/library/sources', 'POST', {
      title: 'SHADOW Canonical Authority Model',
      publisher: 'Punxsy Prominence',
      source_type: 'internal_policy',
      authority_tier: 1,
      status: 'active',
      publication_date: '2026-07-15',
      metadata: { canonical: true, doctrine_kind: 'shadow-authority-model' },
    }));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.source.source_id).toMatch(/^source_/);
    sourceId = payload.source.source_id;
  });

  test('the seed script can find the source it just registered', async () => {
    const response = await routes.getSources(
      new NextRequest(
        'http://localhost/api/pilot/shadow/library/sources?source_type=internal_policy&status=active&limit=200',
        { method: 'GET' },
      ),
    );
    const payload = await response.json();

    // findCanonicalSource matches on this metadata, and re-registers the whole
    // doctrine set if it comes back empty.
    const found = payload.items.find(
      (item: { metadata?: Record<string, unknown> }) => item.metadata?.doctrine_kind === 'shadow-authority-model',
    );
    expect(found).toBeDefined();
    expect(found.source_id).toBe(sourceId);
  });

  test('step 3: registers a document against that source', async () => {
    const response = await routes.postDocument(jsonRequest('/api/pilot/shadow/library/documents', 'POST', {
      source_id: sourceId,
      document_name: 'SHADOW Canonical Authority Model',
      content_sha256: 'b'.repeat(64),
      ingest_state: 'chunking',
      metadata: { canonical: true },
    }));
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.document.document_id).toMatch(/^doc_/);
    documentId = payload.document.document_id;
  });

  test('step 4: registers chunks against that document', async () => {
    const response = await routes.postChunk(jsonRequest('/api/pilot/shadow/library/chunks', 'POST', {
      document_id: documentId,
      ordinal: 0,
      text_content: DOCTRINE,
      metadata: { canonical: true, chunk_type: 'doctrine' },
    }));

    expect(response.status).toBe(201);

    const rows = await rawQuery<{ text_content: string }>(
      'select text_content from pilot.shadow_library_chunks where document_id = $1',
      [documentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].text_content).toBe(DOCTRINE);
  });

  test('a freshly seeded chunk is NOT yet retrievable', async () => {
    const results = await search('clinical conclusion evidence');

    // This is the review gate doing its job, not a failure. Everything written
    // above is pending_review/unverified, and searchShadowLibrary requires an
    // approved, verified, indexed document. Seeding alone must never make
    // content citable.
    expect(results).toHaveLength(0);
  });

  test('approving the source alone is still not enough', async () => {
    const response = await routes.patchReview(jsonRequest('/api/pilot/shadow/evidence/review', 'PATCH', {
      entityType: 'source',
      entityId: sourceId,
      action: 'review',
      approvalState: 'approved',
    }));
    expect(response.status).toBe(200);

    // The document is still un-indexed and unapproved.
    expect(await search('clinical conclusion evidence')).toHaveLength(0);
  });

  test('the full review sequence makes the chunk retrievable', async () => {
    const indexing = await routes.patchReview(jsonRequest('/api/pilot/shadow/evidence/review', 'PATCH', {
      entityType: 'document',
      entityId: documentId,
      action: 'complete_indexing',
    }));
    expect(indexing.status).toBe(200);

    const approval = await routes.patchReview(jsonRequest('/api/pilot/shadow/evidence/review', 'PATCH', {
      entityType: 'document',
      entityId: documentId,
      action: 'review',
      approvalState: 'approved',
    }));
    expect(approval.status).toBe(200);

    const results = await search('clinical conclusion evidence');

    // The cascade the audit traced -- no write path -> empty search -> zero
    // citations -> decorative evidence tiers -- is closed at its first link.
    expect(results).toHaveLength(1);
    expect(results[0].text_content).toBe(DOCTRINE);
    expect(results[0].source_title).toBe('SHADOW Canonical Authority Model');
    expect(results[0].authority_tier).toBe(1);
  });

  test('adding a chunk to an approved document withdraws it from search again', async () => {
    const response = await routes.postChunk(jsonRequest('/api/pilot/shadow/library/chunks', 'POST', {
      document_id: documentId,
      ordinal: 1,
      text_content: 'A second passage added after the reviewer approved the first.',
    }));
    expect(response.status).toBe(201);

    // createShadowLibraryChunk resets the document to chunking/pending_review.
    // The reviewer approved the text they saw, not text that arrived later, so
    // the whole document must go back through review.
    expect(await search('clinical conclusion evidence')).toHaveLength(0);
  });
});

describe('capability coverage (real database)', () => {
  test('a rule with no matching source grades as uncovered', async () => {
    const response = await routes.postCoverage(
      jsonRequest('/api/pilot/shadow/library/capability-coverage', 'POST', {
        capability_key: 'shadow.doctrine.nutrition',
        required_source_types: ['peer_reviewed'],
        minimum_authority_tier: 1,
        minimum_source_count: 1,
      }),
    );
    expect(response.status).toBe(201);

    const recompute = await routes.postCoverage(
      jsonRequest('/api/pilot/shadow/library/capability-coverage', 'POST', { action: 'recompute' }),
    );
    const payload = await recompute.json();

    const rule = payload.items.find(
      (item: { capability_key: string }) => item.capability_key === 'shadow.doctrine.nutrition',
    );
    expect(rule.coverage_state).toBe('uncovered');
  });

  test('a rule matching the registered doctrine source grades as covered', async () => {
    await routes.postCoverage(jsonRequest('/api/pilot/shadow/library/capability-coverage', 'POST', {
      capability_key: 'shadow.doctrine.authority-boundary',
      required_source_types: ['internal_policy'],
      minimum_authority_tier: 1,
      minimum_source_count: 1,
    }));

    const recompute = await routes.postCoverage(
      jsonRequest('/api/pilot/shadow/library/capability-coverage', 'POST', { action: 'recompute' }),
    );
    const payload = await recompute.json();

    const rule = payload.items.find(
      (item: { capability_key: string }) => item.capability_key === 'shadow.doctrine.authority-boundary',
    );
    expect(rule.coverage_state).toBe('covered');
  });

  test('re-upserting the same capability_key updates rather than duplicating', async () => {
    await routes.postCoverage(jsonRequest('/api/pilot/shadow/library/capability-coverage', 'POST', {
      capability_key: 'shadow.doctrine.authority-boundary',
      required_source_types: ['internal_policy'],
      minimum_authority_tier: 2,
      minimum_source_count: 3,
    }));

    const rows = await rawQuery<{ minimum_source_count: number }>(
      `select minimum_source_count from pilot.shadow_library_capability_map
       where organization_id = $1 and capability_key = $2`,
      [ORG_ID, 'shadow.doctrine.authority-boundary'],
    );

    // The seed script re-runs on every deploy; a duplicating upsert would grow
    // the rule table without bound.
    expect(rows).toHaveLength(1);
    expect(rows[0].minimum_source_count).toBe(3);
  });
});

describe('organization scoping (real database)', () => {
  test('a source registered in another organization is invisible and unusable', async () => {
    mockRequirePrincipal.mockResolvedValue({
      ...principal(),
      accountId: OTHER_ACCOUNT_ID,
      organizationId: OTHER_ORG_ID,
    });
    const otherSource = await routes.postSource(jsonRequest('/api/pilot/shadow/library/sources', 'POST', {
      title: 'Other org doctrine',
      source_type: 'internal_policy',
      authority_tier: 1,
    }));
    const otherSourceId = (await otherSource.json()).source.source_id;

    mockRequirePrincipal.mockResolvedValue(principal());

    const listed = await routes.getSources(
      new NextRequest('http://localhost/api/pilot/shadow/library/sources?limit=200', { method: 'GET' }),
    );
    const items = (await listed.json()).items as { source_id: string }[];
    expect(items.some((item) => item.source_id === otherSourceId)).toBe(false);

    // And it cannot be adopted by naming its id from this organization.
    const adopt = await routes.postDocument(jsonRequest('/api/pilot/shadow/library/documents', 'POST', {
      source_id: otherSourceId,
      document_name: 'Adopted document',
    }));
    expect(adopt.status).toBe(404);
  });
});
