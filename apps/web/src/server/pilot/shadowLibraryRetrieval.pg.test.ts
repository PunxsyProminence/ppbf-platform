// Real PostgreSQL-backed tests for what Library retrieval can reach: semantic
// search ranking (CL-C13) and the empty-Library check (CL-C21).
//
// Semantic search used to load at most 200 candidate chunks, chosen by
// `authority_tier asc, created_at asc` -- not by relevance -- and rank only
// those. With more embedded chunks than that, the best match could sit outside
// the 200 and never be found. shadowLibrary.test.ts mocks the database and
// cannot see which rows a SQL statement returns; this file runs the real
// search against real rows.
//
// './db' is mocked to route into the embedded server (the same pattern as
// shadowEvidenceSuppression.pg.test.ts). './shadowEmbeddings' is mocked for
// enablement and the network call only; the query vector is given here.
//
// Spins up the same disposable, local-only embedded Postgres the other
// library suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

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
  withTransaction: jest.fn(),
}));
jest.mock('./shadowTelemetry', () => ({ writeShadowTelemetryEvent: jest.fn() }));
jest.mock('./shadowEmbeddings', () => ({
  ...jest.requireActual('./shadowEmbeddings'),
  isSemanticLibrarySearchEnabled: jest.fn(() => true),
  embedText: jest.fn(),
  getEmbeddingDeploymentName: jest.fn(() => 'test-embedding'),
}));

import { hasRetrievableLibraryEvidence } from './shadowEvidence';
import { embedText } from './shadowEmbeddings';
import { searchShadowLibrary, type ShadowLibrarySearchDetail } from './shadowLibrary';

jest.setTimeout(180_000);

const mockEmbedText = jest.mocked(embedText);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-library-retrieval-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG_ID = 'org-semantic';
const ADMIN_ID = 'acct-semantic-admin';
// The production deployment's width (text-embedding-3-small). The timing check
// below also fills every element with a realistic float, so the text Postgres
// sends and the app parses is about the size of a real embedding's.
const DIMENSIONS = 1536;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let schemaSql: string[];

const SCHEMA_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_shadow_runtime_migration.sql',
  'pilot_slice_postgres_shadow_evidence_migration.sql',
  'pilot_slice_postgres_shadow_chunk_embedding_migration.sql',
  'pilot_slice_postgres_retraction_surveillance_migration.sql',
  'pilot_slice_postgres_platform_library_scope_migration.sql',
];

const searchInput = {
  organizationId: ORG_ID,
  actorAccountId: ADMIN_ID,
  actorRole: 'organization_admin' as const,
  queryText: 'southpaw footwork pivot',
  limit: 3,
};

/** A unit vector along one axis, as the JS array embedText would return. */
function axis(index: number): number[] {
  return Array.from({ length: DIMENSIONS }, (_, i) => (i === index ? 1 : 0));
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

async function freshDatabase(name: string): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  for (const sql of schemaSql) {
    await client.query(sql);
  }
  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_ID],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [ADMIN_ID, ORG_ID],
  );
  return client;
}

/** One servable (approved, verified, indexed) source with one document. */
async function servableSource(client: Client, sourceId: string, authorityTier: number): Promise<string> {
  const documentId = `${sourceId}-doc`;
  await client.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, status,
        approval_state, verification_state,
        approved_by_account_id, approved_at, verified_by_account_id, verified_at)
     values ($1, $2, $1, 'article', $3, 'active', 'approved', 'verified', $4, now(), $4, now())`,
    [sourceId, ORG_ID, authorityTier, ADMIN_ID],
  );
  await client.query(
    `insert into pilot.shadow_library_documents
       (document_id, source_id, organization_id, document_name, ingest_state, index_completed_at,
        approval_state, verification_state,
        approved_by_account_id, approved_at, verified_by_account_id, verified_at)
     values ($1, $2, $3, $1, 'indexed', now(), 'approved', 'verified', $4, now(), $4, now())`,
    [documentId, sourceId, ORG_ID, ADMIN_ID],
  );
  return documentId;
}

/**
 * `count` embedded chunks of one source, every one pointing along `axisIndex`,
 * created at `createdAt` + ordinal seconds. Built in SQL so a large set costs
 * one round trip.
 */
async function embeddedChunks(client: Client, input: {
  sourceId: string;
  documentId: string;
  prefix: string;
  count: number;
  axisIndex: number;
  createdAt: string;
  embeddingModel?: string;
  /** Fill the other axes with tiny random floats (real-sized text, near-zero score). */
  realisticNoise?: boolean;
}): Promise<void> {
  await client.query(
    `insert into pilot.shadow_library_chunks
       (chunk_id, document_id, source_id, organization_id, ordinal, text_content,
        embedding, embedding_model, created_at)
     select $3 || n, $1, $2, $4, n, 'Chunk ' || n,
            (select jsonb_agg(
                      case when i = $6 then 1::float8
                           when $10 then round((random() * 0.02 - 0.01)::numeric, 9)::float8
                           else 0::float8 end
                      order by i)
               from generate_series(0, $7 - 1) as i),
            $8, $9::timestamptz + make_interval(secs => n)
       from generate_series(0, $5 - 1) as n`,
    [
      input.documentId,
      input.sourceId,
      input.prefix,
      ORG_ID,
      input.count,
      input.axisIndex,
      DIMENSIONS,
      input.embeddingModel ?? 'test-embedding',
      input.createdAt,
      input.realisticNoise ?? false,
    ],
  );
}

async function search() {
  const detail: ShadowLibrarySearchDetail = { nearest: [], mode: 'keyword' };
  const relevant = await searchShadowLibrary(searchInput, detail);
  return { relevant, mode: detail.mode };
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
  schemaSql = await Promise.all(
    SCHEMA_FILES.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );
});

afterAll(async () => {
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

afterEach(async () => {
  if (activeClient) await activeClient.end().catch(() => {});
  activeClient = null;
});

beforeEach(() => {
  mockEmbedText.mockResolvedValue(axis(0));
});

describe('semantic Library search ranks every servable chunk (CL-C13)', () => {
  it('finds the one relevant chunk behind 250 older, higher-tier unrelated ones', async () => {
    activeClient = await freshDatabase('semantic_beyond_200');
    // 250 tier-1 chunks, created first, all orthogonal to the question: the old
    // `order by authority_tier, created_at limit 200` filled its window with these.
    const noiseDoc = await servableSource(activeClient, 'source-noise', 1);
    await embeddedChunks(activeClient, {
      sourceId: 'source-noise', documentId: noiseDoc, prefix: 'noise-',
      count: 250, axisIndex: 1, createdAt: '2026-01-01T00:00:00Z',
    });
    // The answer: lower tier, added last.
    const answerDoc = await servableSource(activeClient, 'source-answer', 3);
    await embeddedChunks(activeClient, {
      sourceId: 'source-answer', documentId: answerDoc, prefix: 'answer-',
      count: 1, axisIndex: 0, createdAt: '2026-06-01T00:00:00Z',
    });

    const { relevant, mode } = await search();

    expect(mode).toBe('semantic');
    expect(relevant.map((row) => row.chunk_id)).toEqual(['answer-0']);
    expect(relevant[0].score).toBeCloseTo(1, 6);
    expect(relevant[0]).not.toHaveProperty('embedding');
  });

  it('scores a partial match by real cosine similarity', async () => {
    activeClient = await freshDatabase('semantic_cosine');
    const doc = await servableSource(activeClient, 'source-mixed', 2);
    await activeClient.query(
      `insert into pilot.shadow_library_chunks
         (chunk_id, document_id, source_id, organization_id, ordinal, text_content, embedding, embedding_model)
       values ('diag', $1, 'source-mixed', $2, 0, 'diag', $3::jsonb, 'test-embedding')`,
      // Not unit length: cosine must divide by both norms. cos = 3 / 5 = 0.6.
      [doc, ORG_ID, JSON.stringify([3, 4, ...Array(DIMENSIONS - 2).fill(0)])],
    );

    const { relevant } = await search();

    expect(relevant.map((row) => row.chunk_id)).toEqual(['diag']);
    expect(relevant[0].score).toBeCloseTo(0.6, 6);
  });

  it('skips a malformed or wrong-width embedding instead of failing the search', async () => {
    activeClient = await freshDatabase('semantic_malformed');
    const doc = await servableSource(activeClient, 'source-odd', 2);
    await activeClient.query(
      `insert into pilot.shadow_library_chunks
         (chunk_id, document_id, source_id, organization_id, ordinal, text_content, embedding, embedding_model)
       values
         ('short', $1, 'source-odd', $2, 0, 'short', '[1, 0]'::jsonb, 'test-embedding'),
         ('text', $1, 'source-odd', $2, 1, 'text', $3::jsonb, 'test-embedding'),
         ('object', $1, 'source-odd', $2, 2, 'object', '{"a": 1}'::jsonb, 'test-embedding'),
         ('zero', $1, 'source-odd', $2, 3, 'zero', $4::jsonb, 'test-embedding')`,
      [
        doc,
        ORG_ID,
        JSON.stringify(['1', ...Array(DIMENSIONS - 1).fill(0)]),
        JSON.stringify(Array(DIMENSIONS).fill(0)),
      ],
    );
    const goodDoc = await servableSource(activeClient, 'source-good', 2);
    await embeddedChunks(activeClient, {
      sourceId: 'source-good', documentId: goodDoc, prefix: 'good-',
      count: 1, axisIndex: 0, createdAt: '2026-06-01T00:00:00Z',
    });

    const { relevant } = await search();

    expect(relevant.map((row) => row.chunk_id)).toEqual(['good-0']);
  });

  it('still ignores chunks embedded by another deployment', async () => {
    activeClient = await freshDatabase('semantic_other_model');
    const doc = await servableSource(activeClient, 'source-retired', 1);
    await embeddedChunks(activeClient, {
      sourceId: 'source-retired', documentId: doc, prefix: 'retired-',
      count: 1, axisIndex: 0, createdAt: '2026-01-01T00:00:00Z', embeddingModel: 'retired-embedding',
    });

    const { relevant, mode } = await search();

    expect(relevant).toEqual([]);
    // No candidate on the current deployment: the keyword path answers.
    expect(mode).toBe('keyword');
  });

  it('ranks a corpus the size of the research Library in reasonable time', async () => {
    activeClient = await freshDatabase('semantic_timing');
    const doc = await servableSource(activeClient, 'source-bulk', 2);
    // About the 1,173 chunks the research corpus held when shadowEvidence.ts
    // was written, so three keyset batches. The answer's id sorts after every
    // bulk id, so it arrives in the LAST batch: a paging bug that dropped or
    // stopped short of a batch would miss it.
    await embeddedChunks(activeClient, {
      sourceId: 'source-bulk', documentId: doc, prefix: 'bulk-',
      count: 1_200, axisIndex: 1, createdAt: '2026-01-01T00:00:00Z', realisticNoise: true,
    });
    const answerDoc = await servableSource(activeClient, 'source-answer', 3);
    await embeddedChunks(activeClient, {
      sourceId: 'source-answer', documentId: answerDoc, prefix: 'z-answer-',
      count: 1, axisIndex: 0, createdAt: '2026-06-01T00:00:00Z', realisticNoise: true,
    });

    const started = Date.now();
    const { relevant } = await search();
    const elapsedMs = Date.now() - started;
    console.log(`semantic search over 1,201 chunks x ${DIMENSIONS} dims: ${elapsedMs} ms`);

    expect(relevant.map((row) => row.chunk_id)).toEqual(['z-answer-0']);
    expect(elapsedMs).toBeLessThan(15_000);
  });
});

// hasRetrievableLibraryEvidence decides whether an empty answer means "nothing
// matched" or "the Library holds nothing anyone can retrieve" (the empty-Library
// notice). It must count only what a gym-wide search could return: an
// athlete-scoped chunk is retrievable for that athlete alone, so a Library
// holding only those is empty for everyone else (CL-C21).
describe('the empty-Library check counts only gym-wide servable evidence (CL-C21)', () => {
  it('reads a Library holding only athlete-scoped chunks as empty', async () => {
    activeClient = await freshDatabase('retrievable_athlete_only');
    const doc = await servableSource(activeClient, 'source-athlete', 2);
    await activeClient.query(
      `insert into pilot.shadow_library_chunks
         (chunk_id, document_id, source_id, organization_id, subject_id, ordinal, text_content)
       values ('athlete-chunk', $1, 'source-athlete', $2, 'athlete-1', 0, 'Athlete-specific note.')`,
      [doc, ORG_ID],
    );

    await expect(hasRetrievableLibraryEvidence({ organizationId: ORG_ID })).resolves.toBe(false);
  });

  it('reads a Library holding a gym-wide servable chunk as not empty (control)', async () => {
    activeClient = await freshDatabase('retrievable_gym_wide');
    const doc = await servableSource(activeClient, 'source-gym', 2);
    await activeClient.query(
      `insert into pilot.shadow_library_chunks
         (chunk_id, document_id, source_id, organization_id, ordinal, text_content)
       values ('gym-chunk', $1, 'source-gym', $2, 0, 'Gym-wide passage.')`,
      [doc, ORG_ID],
    );

    await expect(hasRetrievableLibraryEvidence({ organizationId: ORG_ID })).resolves.toBe(true);
  });

  it('reads a Library whose only source is retraction-suppressed as empty', async () => {
    activeClient = await freshDatabase('retrievable_suppressed');
    const doc = await servableSource(activeClient, 'source-retracted', 2);
    await activeClient.query(
      `insert into pilot.shadow_library_chunks
         (chunk_id, document_id, source_id, organization_id, ordinal, text_content)
       values ('retracted-chunk', $1, 'source-retracted', $2, 0, 'Retracted passage.')`,
      [doc, ORG_ID],
    );
    await activeClient.query(
      // What suppressSource writes: the flag, its reason and who; the approvals stay.
      `update pilot.shadow_library_sources
          set retrieval_suppressed = true,
              suppression_reason = 'Retracted by the publisher (test fixture).',
              suppressed_at = now(),
              suppressed_by_account_id = $1
        where source_id = 'source-retracted'`,
      [ADMIN_ID],
    );

    await expect(hasRetrievableLibraryEvidence({ organizationId: ORG_ID })).resolves.toBe(false);
  });
});
