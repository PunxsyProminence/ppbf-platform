// Real PostgreSQL-backed test for platform-shelf writes (RINT-05a).
//
// OD-2026-10-02-013 answer 1B: the platform owner writes the platform shelf
// (`__platform__`) in the app. OD-2026-10-02-015 D3: the platform owner no
// longer writes a gym's shelf. Until this change the only writer of the
// platform shelf was an operator script, so nothing had ever run the library
// write functions -- with their events, telemetry and review-pair columns --
// under the reserved organization through an authenticated actor. The unit
// tests mock shadowLibrary; only a real schema can say whether those rows land.
//
// Spins up the same disposable, local-only embedded Postgres instance the
// pipeline suite uses (scripts/test-embedded-pg-server.mjs). It NEVER connects
// to production or staging.

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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-platform-shelf-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_platform_shelf';

const PLATFORM = '__platform__';
const GYM_ID = 'org-shelf-gym';
const OWNER_ACCOUNT = 'acct-platform-owner';
const GYM_ADMIN_ACCOUNT = 'acct-gym-admin';

// Same set as shadowLibraryPipeline.pg.test.ts: the base schema, the columns
// access.ts and search depend on, and the migration that creates the reserved
// organization and its constraints.
const SCHEMA_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_shadow_runtime_migration.sql',
  'pilot_slice_postgres_shadow_evidence_migration.sql',
  'pilot_slice_postgres_shadow_chunk_embedding_migration.sql',
  'pilot_slice_postgres_retraction_surveillance_migration.sql',
  'pilot_slice_postgres_platform_library_scope_migration.sql',
  // The rights marker and the full-text rule the library writers now carry.
  'pilot_slice_postgres_source_rights_migration.sql',
];

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;

type Routes = {
  postSource: typeof import('@/app/api/pilot/shadow/library/sources/route').POST;
  getSources: typeof import('@/app/api/pilot/shadow/library/sources/route').GET;
  patchSource: typeof import('@/app/api/pilot/shadow/library/sources/route').PATCH;
  postDocument: typeof import('@/app/api/pilot/shadow/library/documents/route').POST;
  postChunk: typeof import('@/app/api/pilot/shadow/library/chunks/route').POST;
  getReview: typeof import('@/app/api/pilot/shadow/evidence/review/route').GET;
  patchReview: typeof import('@/app/api/pilot/shadow/evidence/review/route').PATCH;
  library: typeof import('./shadowLibrary');
};

let routes: Routes;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

// The platform owner's account lives in a gym (no account may exist in
// __platform__), so its principal carries that gym's id. The shelf it writes
// must come from the request's `shelf`, resolved on the server -- never from
// principal.organizationId.
function ownerPrincipal(): PilotPrincipal {
  return {
    accountId: OWNER_ACCOUNT,
    role: 'platform_owner',
    organizationId: GYM_ID,
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function gymAdminPrincipal(): PilotPrincipal {
  return { ...ownerPrincipal(), accountId: GYM_ADMIN_ACCOUNT, role: 'organization_admin' };
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
  await migrateClient.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [GYM_ID],
  );
  for (const [accountId, role] of [[OWNER_ACCOUNT, 'platform_owner'], [GYM_ADMIN_ACCOUNT, 'organization_admin']]) {
    await migrateClient.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft') on conflict do nothing`,
      [accountId, role, GYM_ID],
    );
  }
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  routes = {
    postSource: (await import('@/app/api/pilot/shadow/library/sources/route')).POST,
    getSources: (await import('@/app/api/pilot/shadow/library/sources/route')).GET,
    patchSource: (await import('@/app/api/pilot/shadow/library/sources/route')).PATCH,
    postDocument: (await import('@/app/api/pilot/shadow/library/documents/route')).POST,
    postChunk: (await import('@/app/api/pilot/shadow/library/chunks/route')).POST,
    getReview: (await import('@/app/api/pilot/shadow/evidence/review/route')).GET,
    patchReview: (await import('@/app/api/pilot/shadow/evidence/review/route')).PATCH,
    library: await import('./shadowLibrary'),
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
  mockRequirePrincipal.mockResolvedValue(ownerPrincipal());
});

// Step 0 of the lane: do the server functions themselves -- events, telemetry,
// the review-pair columns, the completeness gate -- hold under __platform__
// with a platform-owner actor whose account lives in another organization?
describe('the library server functions run under __platform__ (real database)', () => {
  test('register, fill, index and approve a platform row; a gym reader can then retrieve it', async () => {
    const { library } = routes;
    const source = await library.createShadowLibrarySource({
      organizationId: PLATFORM,
      actorAccountId: OWNER_ACCOUNT,
      actorRole: 'platform_owner',
      title: 'Quokka Platform Paper',
      sourceType: 'peer_reviewed',
      authorityTier: 2,
      status: 'active',
    });
    const document = await library.createShadowLibraryDocument({
      organizationId: PLATFORM,
      actorAccountId: OWNER_ACCOUNT,
      actorRole: 'platform_owner',
      sourceId: source.source_id,
      documentName: 'Quokka excerpt',
      metadata: { intake_method: 'manual_text', locator: 'p. 3', chunk_count: 1 },
    });
    await library.createShadowLibraryChunk({
      organizationId: PLATFORM,
      actorAccountId: OWNER_ACCOUNT,
      actorRole: 'platform_owner',
      documentId: document.document_id,
      ordinal: 0,
      textContent: 'Quokka step-zero passage about platform evidence.',
      excerptLocator: 'p. 3',
    });
    await library.reviewShadowLibrarySource({
      organizationId: PLATFORM,
      actorAccountId: OWNER_ACCOUNT,
      actorRole: 'platform_owner',
      sourceId: source.source_id,
      approvalState: 'approved',
      verificationState: 'verified',
    });
    await library.completeShadowLibraryDocumentIndexing({
      organizationId: PLATFORM,
      actorAccountId: OWNER_ACCOUNT,
      actorRole: 'platform_owner',
      documentId: document.document_id,
    });
    await library.reviewShadowLibraryDocument({
      organizationId: PLATFORM,
      actorAccountId: OWNER_ACCOUNT,
      actorRole: 'platform_owner',
      documentId: document.document_id,
      approvalState: 'approved',
      verificationState: 'verified',
    });

    const events = await rawQuery<{ event_name: string; organization_id: string }>(
      `select event_name, organization_id from pilot.shadow_events
       where entity_id in ($1, $2) order by event_name`,
      [source.source_id, document.document_id],
    );
    expect(events.map((row) => row.organization_id)).toEqual(events.map(() => PLATFORM));
    expect(events.length).toBeGreaterThanOrEqual(2);

    const results = await library.searchShadowLibrary({
      organizationId: GYM_ID,
      actorAccountId: GYM_ADMIN_ACCOUNT,
      actorRole: 'organization_admin',
      athleteId: null,
      scope: 'scoped',
      queryText: 'quokka platform evidence',
    });
    expect(results.map((row) => row.text_content)).toEqual(['Quokka step-zero passage about platform evidence.']);
  });
});

// The lane's "done when", through the real routes against the real schema: a
// platform_owner request with shelf: platform registers, fills, indexes and
// approves rows in __platform__ and nowhere else; every other role gets 403;
// the platform owner no longer writes a gym's shelf (D3).
describe('platform-shelf writes through the routes (real database)', () => {
  const TEXT = 'Wombat platform passage entered through the routes.';
  let sourceId: string;
  let documentId: string;

  async function rowCounts(organizationId: string) {
    const [row] = await rawQuery<{ sources: string; documents: string; chunks: string }>(
      `select
         (select count(*) from pilot.shadow_library_sources where organization_id = $1)::text as sources,
         (select count(*) from pilot.shadow_library_documents where organization_id = $1)::text as documents,
         (select count(*) from pilot.shadow_library_chunks where organization_id = $1)::text as chunks`,
      [organizationId],
    );
    return row;
  }

  test('platform_owner registers, fills, indexes and approves on __platform__, and the gym shelf is untouched', async () => {
    const gymBefore = await rowCounts(GYM_ID);

    const source = await routes.postSource(jsonRequest('/api/pilot/shadow/library/sources', 'POST', {
      title: 'Wombat Platform Paper',
      source_type: 'peer_reviewed',
      authority_tier: 2,
      status: 'active',
      shelf: 'platform',
      organization_id: GYM_ID,
    }));
    expect(source.status).toBe(201);
    sourceId = (await source.json()).source.source_id;

    const document = await routes.postDocument(jsonRequest('/api/pilot/shadow/library/documents', 'POST', {
      source_id: sourceId,
      document_name: 'Wombat excerpt',
      metadata: { intake_method: 'manual_text', locator: 'p. 7', chunk_count: 1 },
      shelf: 'platform',
    }));
    expect(document.status).toBe(201);
    documentId = (await document.json()).document.document_id;

    const chunk = await routes.postChunk(jsonRequest('/api/pilot/shadow/library/chunks', 'POST', {
      document_id: documentId,
      ordinal: 0,
      text_content: TEXT,
      metadata: { intake_method: 'manual_text', locator: 'p. 7', join_before: '' },
      shelf: 'platform',
    }));
    expect(chunk.status).toBe(201);

    for (const body of [
      { entityType: 'source', entityId: sourceId, action: 'review', approvalState: 'approved' },
      { entityType: 'document', entityId: documentId, action: 'complete_indexing' },
      { entityType: 'document', entityId: documentId, action: 'review', approvalState: 'approved' },
    ]) {
      const response = await routes.patchReview(jsonRequest('/api/pilot/shadow/evidence/review', 'PATCH', { ...body, shelf: 'platform' }));
      expect(response.status).toBe(200);
    }

    const rows = await rawQuery<{ organization_id: string; approval_state: string; approved_by_account_id: string | null }>(
      `select organization_id, approval_state, approved_by_account_id from pilot.shadow_library_sources where source_id = $1
       union all
       select organization_id, approval_state, approved_by_account_id from pilot.shadow_library_documents where document_id = $2`,
      [sourceId, documentId],
    );
    expect(rows).toEqual([
      { organization_id: PLATFORM, approval_state: 'approved', approved_by_account_id: OWNER_ACCOUNT },
      { organization_id: PLATFORM, approval_state: 'approved', approved_by_account_id: OWNER_ACCOUNT },
    ]);
    expect(await rowCounts(GYM_ID)).toEqual(gymBefore);

    const listed = await routes.getSources(new NextRequest('http://localhost/api/pilot/shadow/library/sources?shelf=platform', { method: 'GET' }));
    expect((await listed.json()).items.map((item: { source_id: string }) => item.source_id)).toContain(sourceId);

    const queue = await routes.getReview(new NextRequest('http://localhost/api/pilot/shadow/evidence/review?shelf=platform', { method: 'GET' }));
    expect((await queue.json()).documents.map((doc: { document_id: string }) => doc.document_id)).toContain(documentId);
  });

  test('a gym admin gets 403 on the platform shelf and writes nothing there', async () => {
    mockRequirePrincipal.mockResolvedValue(gymAdminPrincipal());
    const before = await rowCounts(PLATFORM);

    const responses = [
      await routes.postSource(jsonRequest('/api/pilot/shadow/library/sources', 'POST', {
        title: 'Gym admin attempt', source_type: 'peer_reviewed', shelf: 'platform',
      })),
      await routes.postDocument(jsonRequest('/api/pilot/shadow/library/documents', 'POST', {
        source_id: sourceId, document_name: 'Gym admin attempt', shelf: 'platform',
      })),
      await routes.postChunk(jsonRequest('/api/pilot/shadow/library/chunks', 'POST', {
        document_id: documentId, ordinal: 1, text_content: 'Gym admin attempt.', shelf: 'platform',
      })),
      await routes.patchReview(jsonRequest('/api/pilot/shadow/evidence/review', 'PATCH', {
        entityType: 'document', entityId: documentId, action: 'review', approvalState: 'rejected', shelf: 'platform',
      })),
    ];

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    expect(await rowCounts(PLATFORM)).toEqual(before);
    const [doc] = await rawQuery<{ approval_state: string }>(
      'select approval_state from pilot.shadow_library_documents where document_id = $1',
      [documentId],
    );
    expect(doc.approval_state).toBe('approved');
  });

  test('a platform row cannot be reached through the gym shelf: platform ids read as not found', async () => {
    mockRequirePrincipal.mockResolvedValue(gymAdminPrincipal());

    const chunk = await routes.postChunk(jsonRequest('/api/pilot/shadow/library/chunks', 'POST', {
      document_id: documentId, ordinal: 1, text_content: 'Through the gym shelf.',
    }));
    const review = await routes.patchReview(jsonRequest('/api/pilot/shadow/evidence/review', 'PATCH', {
      entityType: 'source', entityId: sourceId, action: 'review', approvalState: 'rejected',
    }));

    expect([chunk.status, review.status]).toEqual([404, 404]);
  });

  test('D3: the platform owner cannot write the gym shelf, named or not', async () => {
    const before = await rowCounts(GYM_ID);

    for (const shelf of [undefined, 'gym']) {
      const response = await routes.postSource(jsonRequest('/api/pilot/shadow/library/sources', 'POST', {
        title: 'Platform owner on the gym shelf', source_type: 'peer_reviewed', ...(shelf ? { shelf } : {}),
      }));
      expect(response.status).toBe(403);
    }
    expect(await rowCounts(GYM_ID)).toEqual(before);
  });

  test('a gym admin without a shelf still writes its own gym, as before', async () => {
    mockRequirePrincipal.mockResolvedValue(gymAdminPrincipal());

    const response = await routes.postSource(jsonRequest('/api/pilot/shadow/library/sources', 'POST', {
      title: 'Gym doctrine', source_type: 'internal_policy',
    }));

    expect(response.status).toBe(201);
    const [row] = await rawQuery<{ organization_id: string }>(
      'select organization_id from pilot.shadow_library_sources where source_id = $1',
      [(await response.json()).source.source_id],
    );
    expect(row.organization_id).toBe(GYM_ID);
  });
});
