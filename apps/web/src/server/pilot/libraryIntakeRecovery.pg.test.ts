// Real PostgreSQL-backed test for retried Library writes (L54; ChatGPT audit
// 2026-10-17 items 2 and 3).
//
// A curator's save is several requests -- register a source, then a document,
// then its chunks -- and any answer can be lost AFTER its row was written. The
// acceptance is that recovery finds and finishes the original work: no second
// source, no second document, no re-entry, and different stored text is never
// reported as saved. The intake client is wired to the real route handlers
// with a fetch that runs the handler and then drops its answer, so what is
// proven is the whole round trip against the real schema.
//
// Spins up the same disposable, local-only embedded Postgres instance the
// other library suites use (scripts/test-embedded-pg-server.mjs). It NEVER
// connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { NextRequest } from 'next/server';
import { Client } from 'pg';

import {
  INTAKE_RECOVERY_WORDS,
  normalizeIntakeText,
  rejoinIntakeChunks,
  splitIntakeText,
  submitLibraryTextIntake,
  type IntakeInput,
} from '@/src/client/libraryTextIntake';
import type { PilotPrincipal } from './auth';
import { requirePrincipal } from './http';
import { emitShadowEvent } from './shadowEvents';

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// Real by default; a test makes one call fail to stand for the event store
// failing after the row it describes was written.
jest.mock('./shadowEvents', () => {
  const actual = jest.requireActual('./shadowEvents');
  return { ...actual, emitShadowEvent: jest.fn((...args: unknown[]) => actual.emitShadowEvent(...args)) };
});

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-intake-recovery-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_intake_recovery';

const GYM_ID = 'org-intake-gym';
const CURATOR = 'acct-intake-curator';
const OTHER_CURATOR = 'acct-intake-other';

// Same set as platformShelfWrites.pg.test.ts.
const SCHEMA_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_shadow_runtime_migration.sql',
  'pilot_slice_postgres_shadow_evidence_migration.sql',
  'pilot_slice_postgres_shadow_chunk_embedding_migration.sql',
  'pilot_slice_postgres_retraction_surveillance_migration.sql',
  'pilot_slice_postgres_platform_library_scope_migration.sql',
  'pilot_slice_postgres_source_rights_migration.sql',
];

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockEmit = jest.mocked(emitShadowEvent);

type Handler = (request: NextRequest) => Promise<Response>;
let handlers: Record<string, Handler>;

function principal(accountId = CURATOR): PilotPrincipal {
  return {
    accountId,
    role: 'organization_admin',
    organizationId: GYM_ID,
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

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

interface RouteCall {
  path: string;
  body: Record<string, unknown>;
  status: number;
}

/**
 * A fetch that runs the real route handler, then drops the answer when `lose`
 * says so: the write happened, the curator's browser never heard.
 */
function routeFetch(lose: (call: RouteCall) => boolean = () => false) {
  const calls: RouteCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const handler = handlers[url.pathname];
    if (!handler) throw new Error(`No route for ${url.pathname}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const response = await handler(new NextRequest(`http://localhost${url.pathname}`, {
      method: init?.method ?? 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }));
    const call = { path: url.pathname, body, status: response.status };
    calls.push(call);
    if (lose(call)) throw new Error('answer lost');
    return response;
  }) as typeof fetch;
  return { calls, impl };
}

function post(pathname: string, body: Record<string, unknown>): Promise<Response> {
  return handlers[pathname](new NextRequest(`http://localhost${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

const SOURCES = '/api/pilot/shadow/library/sources';
const DOCUMENTS = '/api/pilot/shadow/library/documents';
const CHUNKS = '/api/pilot/shadow/library/chunks';

async function registerSource(title: string): Promise<string> {
  const response = await post(SOURCES, { title, source_type: 'peer_reviewed' });
  expect(response.status).toBe(201);
  return ((await response.json()) as { source: { source_id: string } }).source.source_id;
}

// Paragraphs of about 600 characters, so the split makes several parts.
function excerptText(label: string, paragraphs: number, length = 600): string {
  return Array.from({ length: paragraphs }, (_, index) => {
    const head = `${label} paragraph ${index + 1}.`;
    return `${head} ${'load monitoring in adolescent boxers '.repeat(40)}`.slice(0, length).trim();
  }).join('\n\n');
}

function intakeInput(sourceId: string, documentName: string, text: string): IntakeInput {
  return { sourceId, documentName, locator: 'pp. 4-6', text };
}

async function documentsNamed(sourceId: string, documentName: string) {
  return rawQuery<{ document_id: string }>(
    `select document_id from pilot.shadow_library_documents
      where organization_id = $1 and source_id = $2 and document_name = $3`,
    [GYM_ID, sourceId, documentName],
  );
}

async function storedText(documentId: string): Promise<{ ordinals: number[]; text: string }> {
  const rows = await rawQuery<{ ordinal: number; text_content: string; join_before: string | null }>(
    `select ordinal, text_content, metadata->>'join_before' as join_before
       from pilot.shadow_library_chunks
      where organization_id = $1 and document_id = $2
      order by ordinal`,
    [GYM_ID, documentId],
  );
  return {
    ordinals: rows.map((row) => row.ordinal),
    text: rejoinIntakeChunks(rows.map((row) => ({ text: row.text_content, joinBefore: row.join_before ?? '' }))),
  };
}

async function eventCount(entityId: string): Promise<number> {
  const [row] = await rawQuery<{ count: string }>(
    'select count(*)::text as count from pilot.shadow_events where organization_id = $1 and entity_id = $2',
    [GYM_ID, entityId],
  );
  return Number(row.count);
}

beforeAll(async () => {
  delete process.env.AZURE_AI_ENDPOINT;
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
  for (const accountId of [CURATOR, OTHER_CURATOR]) {
    await migrateClient.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
      [accountId, GYM_ID],
    );
  }
  await migrateClient.end();

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';

  handlers = {
    [SOURCES]: (await import('@/app/api/pilot/shadow/library/sources/route')).POST,
    [DOCUMENTS]: (await import('@/app/api/pilot/shadow/library/documents/route')).POST,
    [CHUNKS]: (await import('@/app/api/pilot/shadow/library/chunks/route')).POST,
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

describe('a source registration whose answer is lost (real database)', () => {
  test.each([['without a URL', null], ['with a URL', 'https://example.org/lost-answer-paper']])(
    '%s: the retry gets the source the first request saved, not a second one',
    async (_label, url) => {
      const title = `Lost answer paper ${url ? 'url' : 'no url'}`;
      const body = { title, source_type: 'peer_reviewed', url, request_id: `req-source-${url ? 'url' : 'plain'}-0001` };
      const { impl } = routeFetch(() => true);
      await expect(impl(SOURCES, { method: 'POST', body: JSON.stringify(body) })).rejects.toThrow('answer lost');

      const retry = await post(SOURCES, body);

      expect(retry.status).toBe(200);
      const answer = (await retry.json()) as { recovered: boolean; source: { source_id: string } };
      expect(answer.recovered).toBe(true);
      const rows = await rawQuery<{ source_id: string }>(
        'select source_id from pilot.shadow_library_sources where organization_id = $1 and title = $2',
        [GYM_ID, title],
      );
      expect(rows.map((row) => row.source_id)).toEqual([answer.source.source_id]);
      expect(await eventCount(answer.source.source_id)).toBe(1);
    },
  );

  test("another curator's request id does not hand them this curator's source", async () => {
    const body = { title: 'Request id owned by one curator', source_type: 'peer_reviewed', request_id: 'req-source-owner-0001' };
    const first = await post(SOURCES, body);
    expect(first.status).toBe(201);

    mockRequirePrincipal.mockResolvedValue(principal(OTHER_CURATOR));
    const other = await post(SOURCES, body);

    expect(other.status).toBe(201);
  });

  test('an event failure leaves no source behind, and the retry registers it once', async () => {
    const title = 'Event store fails after the insert';
    const body = { title, source_type: 'peer_reviewed', request_id: 'req-source-event-0001' };
    mockEmit.mockImplementationOnce(async () => {
      throw new Error('event store down');
    });

    const failed = await post(SOURCES, body);

    expect(failed.status).toBe(500);
    expect(await rawQuery('select 1 from pilot.shadow_library_sources where organization_id = $1 and title = $2', [GYM_ID, title]))
      .toHaveLength(0);

    const retry = await post(SOURCES, body);
    expect(retry.status).toBe(201);
    const rows = await rawQuery<{ source_id: string }>(
      'select source_id from pilot.shadow_library_sources where organization_id = $1 and title = $2',
      [GYM_ID, title],
    );
    expect(rows).toHaveLength(1);
    expect(await eventCount(rows[0].source_id)).toBe(1);
  });

  test('a URL another registration holds is a conflict that names that source', async () => {
    const url = 'https://example.org/held-by-someone';
    const first = await post(SOURCES, { title: 'The Paper Already Here', source_type: 'peer_reviewed', url, request_id: 'req-held-0001' });
    expect(first.status).toBe(201);

    const second = await post(SOURCES, { title: 'Same paper again', source_type: 'peer_reviewed', url, request_id: 'req-held-0002' });

    expect(second.status).toBe(409);
    expect(await second.json()).toEqual(expect.objectContaining({
      code: 'SHADOW_LIBRARY_SOURCE_URL_TAKEN',
      existing_source: expect.objectContaining({ title: 'The Paper Already Here' }),
    }));
  });
});

describe('an excerpt whose answers are lost part-way (real database)', () => {
  test('lost after the document is saved: Finish saving finds it and finishes it, with no second document', async () => {
    const sourceId = await registerSource('Lost document answer source');
    const text = excerptText('Lost document', 4);
    const input = intakeInput(sourceId, 'Lost document excerpt', text);

    const first = routeFetch((call) => call.path === DOCUMENTS);
    const stopped = await submitLibraryTextIntake('', input, { fetchImpl: first.impl });
    expect(stopped).toMatchObject({ ok: false, message: INTAKE_RECOVERY_WORDS.documentUnconfirmed, resume: { documentId: null } });
    expect(await documentsNamed(sourceId, 'Lost document excerpt')).toHaveLength(1);
    if (stopped.ok || !stopped.resume) throw new Error('expected a resumable failure');

    const finished = await submitLibraryTextIntake('', input, { resume: stopped.resume, fetchImpl: routeFetch().impl });

    const documents = await documentsNamed(sourceId, 'Lost document excerpt');
    expect(documents).toHaveLength(1);
    expect(finished).toEqual({ ok: true, documentId: documents[0].document_id, chunkCount: splitIntakeText(text).length });
    const stored = await storedText(documents[0].document_id);
    expect(stored.ordinals).toEqual(splitIntakeText(text).map((chunk) => chunk.ordinal));
    expect(stored.text).toBe(normalizeIntakeText(text));
    expect(await eventCount(documents[0].document_id)).toBe(1);
  });

  test('a document event failure leaves no document behind, and Finish saving files it once', async () => {
    const sourceId = await registerSource('Document event failure source');
    const text = excerptText('Event failure', 3);
    const input = intakeInput(sourceId, 'Event failure excerpt', text);
    mockEmit.mockImplementationOnce(async () => {
      throw new Error('event store down');
    });

    const stopped = await submitLibraryTextIntake('', input, { fetchImpl: routeFetch().impl });
    expect(stopped).toMatchObject({ ok: false, resume: { documentId: null } });
    expect(await documentsNamed(sourceId, 'Event failure excerpt')).toHaveLength(0);
    if (stopped.ok || !stopped.resume) throw new Error('expected a resumable failure');

    const finished = await submitLibraryTextIntake('', input, { resume: stopped.resume, fetchImpl: routeFetch().impl });

    expect(finished.ok).toBe(true);
    const documents = await documentsNamed(sourceId, 'Event failure excerpt');
    expect(documents).toHaveLength(1);
    expect((await storedText(documents[0].document_id)).text).toBe(normalizeIntakeText(text));
  });

  test('lost after a middle part: Finish saving completes it once; different text there is a conflict, never saved', async () => {
    const sourceId = await registerSource('Lost middle part source');
    const text = excerptText('Middle part', 5);
    const input = intakeInput(sourceId, 'Middle part excerpt', text);
    const parts = splitIntakeText(text);
    expect(parts.length).toBeGreaterThanOrEqual(3);

    const first = routeFetch((call) => call.path === CHUNKS && call.body.ordinal === 1);
    const stopped = await submitLibraryTextIntake('', input, { fetchImpl: first.impl });
    expect(stopped).toMatchObject({ ok: false, writtenChunks: 1, resume: { nextOrdinal: 1 } });
    if (stopped.ok || !stopped.resume) throw new Error('expected a resumable failure');

    const second = routeFetch();
    const finished = await submitLibraryTextIntake('', input, { resume: stopped.resume, fetchImpl: second.impl });

    expect(finished.ok).toBe(true);
    expect(second.calls[0]).toMatchObject({ path: CHUNKS, status: 200 });
    const documentId = stopped.resume.documentId as string;
    const stored = await storedText(documentId);
    expect(stored.ordinals).toEqual(parts.map((part) => part.ordinal));
    expect(stored.text).toBe(normalizeIntakeText(text));

    // A resume whose part 1 no longer matches what is stored there.
    const altered = {
      ...stopped.resume,
      chunks: stopped.resume.chunks.map((chunk) => (chunk.ordinal === 1 ? { ...chunk, text: 'Different words at part two.' } : chunk)),
    };
    const conflicted = await submitLibraryTextIntake('', input, { resume: altered, fetchImpl: routeFetch().impl });

    expect(conflicted).toEqual({
      ok: false,
      message: INTAKE_RECOVERY_WORDS.chunkConflict(1, parts.length),
      resume: null,
      writtenChunks: 1,
      totalChunks: parts.length,
    });
    expect((await storedText(documentId)).text).toBe(normalizeIntakeText(text));
  });

  test('an identical retry of the last part on a source at its excerpt limit completes', async () => {
    const sourceId = await registerSource('Source at its excerpt limit');
    // Twenty parts of about 1,100 characters: exactly the passage limit.
    const text = excerptText('Capped', 20, 1_100);
    const input = intakeInput(sourceId, 'Capped excerpt', text);
    expect(splitIntakeText(text)).toHaveLength(20);

    const first = routeFetch((call) => call.path === CHUNKS && call.body.ordinal === 19);
    const stopped = await submitLibraryTextIntake('', input, { fetchImpl: first.impl });
    expect(stopped).toMatchObject({ ok: false, writtenChunks: 19, resume: { nextOrdinal: 19 } });
    if (stopped.ok || !stopped.resume) throw new Error('expected a resumable failure');

    const finished = await submitLibraryTextIntake('', input, { resume: stopped.resume, fetchImpl: routeFetch().impl });

    expect(finished.ok).toBe(true);
    expect((await storedText(stopped.resume.documentId as string)).ordinals).toHaveLength(20);
  });

  test('an entry started under one source cannot be finished under another', async () => {
    const sourceId = await registerSource('Original source of an entry');
    const otherSourceId = await registerSource('A different source');
    const body = {
      source_id: sourceId,
      document_name: 'Tied to its source',
      metadata: { intake_method: 'manual_text', locator: 'p. 1', chunk_count: 1 },
      request_id: 'req-document-tied-0001',
    };
    expect((await post(DOCUMENTS, body)).status).toBe(201);

    const moved = await post(DOCUMENTS, { ...body, source_id: otherSourceId });

    expect(moved.status).toBe(409);
    expect((await moved.json()).code).toBe('SHADOW_LIBRARY_INTAKE_SOURCE_MISMATCH');
    expect(await documentsNamed(otherSourceId, 'Tied to its source')).toHaveLength(0);
  });
});
