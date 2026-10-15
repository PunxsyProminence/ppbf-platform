// Real PostgreSQL proof that the retention purge (scripts/pilot-cleanup-
// deleted-data.mjs, run as its own process) deletes the SHADOW Library
// documents filed against a purged athlete (subject_id), with their chunks
// (F-079, #1600 PR 2). A document a SHADOW answer still cites (the
// safeguarding hold) is kept and counted as held, and the child is still
// purged. Another child's, the gym's own, another gym's and a child-inside-
// retention's documents stay; an athlete whose purge is rolled back keeps
// theirs, uncounted. Rows only: no stored file is touched.
//
// Spins up the disposable local-only embedded Postgres the other suites use.
// It NEVER connects to production or staging.

import { type ChildProcessByStdio, execFile, spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-library-document-purge-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const CLEANUP_SCRIPT = path.resolve(__dirname, '../../../scripts/pilot-cleanup-deleted-data.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_library_document_purge';

/* ts-jest compiles a plain `await import()` down to require(), which cannot
   load an ES module here. Building it through Function keeps a real dynamic
   import in the emitted code, honored under --experimental-vm-modules. */
const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const ORG = 'org-lb-1';
const OTHER_ORG = 'org-lb-2';
const ATHLETE_A = 'ath-lb-a'; // purged: deleted three years ago
const ATHLETE_B = 'ath-lb-b'; // live
const ATHLETE_C = 'ath-lb-c'; // deleted, still inside retention
const ATHLETE_D = 'ath-lb-d'; // past retention, but its purge is refused (a video, no storage)
const ADMIN = 'acct-lb-admin';
const COACH = 'acct-lb-coach';
const OTHER_ADMIN = 'acct-lb-admin-2';
const SOURCE = 'src-lb-1';
const OTHER_SOURCE = 'src-lb-2';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;

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

function runCleanupScript(extraEnv: Record<string, string>) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    execFile(
      process.execPath,
      [CLEANUP_SCRIPT],
      {
        env: {
          ...process.env,
          AZURE_POSTGRES_CONNECTION_STRING: connectionStringFor(TEST_DB_NAME),
          PPBF_EXPECTED_POSTGRES_HOSTNAME: 'localhost',
          PPBF_EXPECTED_POSTGRES_DATABASE: TEST_DB_NAME,
          PPBF_POSTGRES_DISABLE_SSL: 'true',
          PPBF_RETENTION_STORAGE_ACCOUNT_URL: '',
          ...extraEnv,
        },
      },
      (_error, stdout, stderr) => {
        const line = `${stdout}${stderr}`.split('\n').find((entry) => entry.trim().startsWith('{'));
        if (!line) {
          reject(new Error(`No JSON output. stdout=${stdout} stderr=${stderr}`));
          return;
        }
        resolve(JSON.parse(line) as Record<string, unknown>);
      },
    );
  });
}

/** Registers one Library document straight into the table, as
 *  createShadowLibraryDocument stores it, with `chunks` chunks that copy its
 *  subject (shadowLibrary.ts). */
async function insertDocument(
  organizationId: string,
  documentId: string,
  sourceId: string,
  subjectId: string | null,
  options: { blobPath?: string | null; chunks?: number } = {},
) {
  await db.query(
    `insert into pilot.shadow_library_documents
       (document_id, source_id, organization_id, subject_id, document_name, blob_path, created_by_account_id, created_by_role)
     values ($1, $2, $3, $4, $1, $5, $6, 'coach')`,
    [documentId, sourceId, organizationId, subjectId, options.blobPath ?? null, organizationId === ORG ? COACH : OTHER_ADMIN],
  );
  for (let ordinal = 0; ordinal < (options.chunks ?? 1); ordinal += 1) {
    await db.query(
      `insert into pilot.shadow_library_chunks
         (chunk_id, document_id, source_id, organization_id, subject_id, ordinal, text_content, text_kind)
       values ($1, $2, $3, $4, $5, $6, $7, 'full_text')`,
      [`${documentId}-c${ordinal}`, documentId, sourceId, organizationId, subjectId, ordinal, `Coach notes ${ordinal}`],
    );
  }
}

/** One chunk with its own subject under an existing document, as the
 *  research importer can write it (import-shadow-research.mjs). */
async function insertChunk(documentId: string, chunkId: string, subjectId: string | null, ordinal: number) {
  await db.query(
    `insert into pilot.shadow_library_chunks
       (chunk_id, document_id, source_id, organization_id, subject_id, ordinal, text_content, text_kind)
     values ($1, $2, $3, $4, $5, $6, 'Imported text', 'full_text')`,
    [chunkId, documentId, SOURCE, ORG, subjectId, ordinal],
  );
}

/** A SHADOW answer's citation of a chunk (by default the document's first),
 *  in a bundle about `bundleSubject` (null: about no one). `citedDocumentId`
 *  is the document id the citation recorded, which a chunk moved since
 *  (pilot-rescope-library-baseline.mjs) no longer matches. */
async function cite(
  documentId: string,
  bundleId: string,
  bundleSubject: string | null,
  options: { chunkId?: string; citedDocumentId?: string } = {},
) {
  await db.query(
    `insert into pilot.shadow_evidence_bundles
       (bundle_id, organization_id, account_id, subject_id, query_sha256, availability, item_count)
     values ($1, $2, $3, $4, $5, 'available', 1)`,
    [bundleId, ORG, COACH, bundleSubject, 'a'.repeat(64)],
  );
  await db.query(
    `insert into pilot.shadow_evidence_items
       (evidence_id, bundle_id, organization_id, account_id, source_id, document_id, chunk_id,
        ordinal, excerpt_sha256, library_organization_id)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 1, $7, $2)`,
    [bundleId, ORG, COACH, SOURCE, options.citedDocumentId ?? documentId, options.chunkId ?? `${documentId}-c0`, 'b'.repeat(64)],
  );
}

const documentCount = async (documentId: string) =>
  Number((await db.query(
    'select count(*)::int as n from pilot.shadow_library_documents where document_id = $1',
    [documentId],
  )).rows[0].n);

const chunkCount = async (documentId: string) =>
  Number((await db.query(
    'select count(*)::int as n from pilot.shadow_library_chunks where document_id = $1',
    [documentId],
  )).rows[0].n);

// About A: the subject as written (two chunks), one padded, one with a file
// path, one cited only in a bundle about A (that bundle goes with A, so the
// document is free to go; its blank path is not counted as a file path).
const ABOUT_A = ['doc-a-plain', 'doc-a-padded', 'doc-a-file', 'doc-a-cited-by-a'];
// Must stay: another child, the gym's own, a child inside retention, another
// gym's same athlete id, an id that only starts with A's.
const KEPT = ['doc-b', 'doc-gym', 'doc-c-recent', 'doc-other-gym-a', 'doc-near-miss', 'doc-gym-stray', 'doc-gym-stray-cited'];
// About A, but cited by a bundle that outlives A (the held-chat case): kept.
// And about A, its chunk cited under the id of the document it was moved
// from: kept too.
// And about A, cited under its own id through a chunk since moved out of it
// to the gym's own document: kept as well.
const HELD = 'doc-a-held';
const HELD_BY_MOVED_CHUNK = 'doc-a-moved-chunk';
const HELD_BY_CHUNK_MOVED_OUT = 'doc-a-chunk-moved-out';

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

  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'Punxsy Prominence', 'active'), ($2, 'Other Gym', 'active')`,
    [ORG, OTHER_ORG],
  );
  for (const [accountId, role, organizationId] of [
    [ADMIN, 'organization_admin', ORG],
    [COACH, 'coach', ORG],
    [OTHER_ADMIN, 'organization_admin', OTHER_ORG],
  ]) {
    await db.query(
      `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
       values ($1, $2, $3, 'microsoft')`,
      [accountId, role, organizationId],
    );
  }
  await db.query(
    `insert into pilot.athletes
       (organization_id, athlete_id, full_name, dob, weight_class, gym_status,
        emergency_contact, active_flag, coach_id, created_at, updated_at, deleted_at)
     values
       ($1, $3, 'Rosa Ortiz', '2012-04-03', 'youth-60', 'active', 'Guardian', false, $7, now(), now(), now() - interval '3 years'),
       ($1, $4, 'Sam Rivera', '2011-02-09', 'youth-65', 'active', 'Guardian', true, $7, now(), now(), null),
       ($1, $5, 'Dee Park', '2013-06-01', 'youth-55', 'active', 'Guardian', false, $7, now(), now(), now() - interval '30 days'),
       ($1, $6, 'Lee Moss', '2012-09-09', 'youth-55', 'active', 'Guardian', false, $7, now(), now(), null),
       ($2, $3, 'Another Child', '2012-01-01', 'youth-60', 'active', 'Guardian', true, $8, now(), now(), null)`,
    [ORG, OTHER_ORG, ATHLETE_A, ATHLETE_B, ATHLETE_C, ATHLETE_D, COACH, OTHER_ADMIN],
  );
  await db.query(
    `insert into pilot.shadow_library_sources (source_id, organization_id, title, source_type, authority_tier, rights_status)
     values ($1, $2, 'Coach observations', 'peer_reviewed', 1, 'ppbf_owned'),
            ($3, $4, 'Coach observations', 'peer_reviewed', 1, 'ppbf_owned')`,
    [SOURCE, ORG, OTHER_SOURCE, OTHER_ORG],
  );

  await insertDocument(ORG, 'doc-a-plain', SOURCE, ATHLETE_A, { chunks: 2 });
  await insertDocument(ORG, 'doc-a-padded', SOURCE, `  ${ATHLETE_A} `);
  await insertDocument(ORG, 'doc-a-file', SOURCE, ATHLETE_A, { blobPath: 'library/org-lb-1/a.pdf' });
  await insertDocument(ORG, 'doc-a-cited-by-a', SOURCE, ATHLETE_A, { blobPath: '  ' });
  await cite('doc-a-cited-by-a', '44444444-4444-4444-8444-444444444444', ATHLETE_A);
  await insertDocument(ORG, HELD, SOURCE, ATHLETE_A, { blobPath: 'library/org-lb-1/held.pdf' });
  await cite(HELD, '55555555-5555-4555-8555-555555555555', null);

  await insertDocument(ORG, HELD_BY_MOVED_CHUNK, SOURCE, ATHLETE_A);
  await insertDocument(ORG, HELD_BY_CHUNK_MOVED_OUT, SOURCE, ATHLETE_A);

  await insertDocument(ORG, 'doc-b', SOURCE, ATHLETE_B);
  await insertDocument(ORG, 'doc-gym', SOURCE, null);
  await insertDocument(ORG, 'doc-c-recent', SOURCE, ATHLETE_C);
  await insertDocument(OTHER_ORG, 'doc-other-gym-a', OTHER_SOURCE, ATHLETE_A);
  await insertDocument(ORG, 'doc-near-miss', SOURCE, `${ATHLETE_A}-2`);
  await cite(HELD_BY_MOVED_CHUNK, '66666666-6666-4666-8666-666666666666', null, { citedDocumentId: 'doc-gym' });
  await insertChunk('doc-gym', 'moved-out', null, 1);
  await cite(HELD_BY_CHUNK_MOVED_OUT, '88888888-8888-4888-8888-888888888888', null, { chunkId: 'moved-out' });

  // The gym's own documents holding an imported chunk about A: the stray
  // chunk goes and the document stays; a cited stray chunk is held.
  await insertDocument(ORG, 'doc-gym-stray', SOURCE, null);
  await insertChunk('doc-gym-stray', 'stray-a', ` ${ATHLETE_A}`, 1);
  await insertDocument(ORG, 'doc-gym-stray-cited', SOURCE, null);
  await insertChunk('doc-gym-stray-cited', 'stray-a-cited', ATHLETE_A, 1);
  await cite('doc-gym-stray-cited', '77777777-7777-4777-8777-777777777777', null, { chunkId: 'stray-a-cited' });

  // A research submission that attached A's document to the gym's own
  // question: the submission stays, its document pointer cleared.
  const requirement = await db.query(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id, research_requirement,
        knowledge_gap, source_status, source_confidence_tier, source_verification_state,
        created_by_account_id, created_by_role)
     values ($1, 'manual', 'manual', 'gym-q', 'GYM-QUESTION', 'gap', 'weak', 'LIMITED', 'unverified', $2, 'coach')
     returning research_requirement_id`,
    [ORG, COACH],
  );
  await db.query(
    `insert into pilot.shadow_research_submissions
       (organization_id, submission_id, research_requirement_id, source_id, document_id, submitted_by_account_id)
     values ($1, 'sub-gym', $2, $3, 'doc-a-plain', $4)`,
    [ORG, requirement.rows[0].research_requirement_id, SOURCE, ADMIN],
  );
});

afterAll(async () => {
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

describe('the retention purge and the Library documents filed against a purged athlete', () => {
  test('a dry run counts what it would delete and hold, and deletes nothing', async () => {
    const dry = await runCleanupScript({ PPBF_RETENTION_APPLY: 'false' });
    expect(dry.event).toBe('retention.cleanup.dry-run');
    expect(dry.blocked_by ?? {}).toEqual({});
    expect(dry.would_delete_subject_library_documents).toBe(4);
    expect(dry.would_delete_subject_library_chunks).toBe(6);
    expect(dry.subject_library_documents_held).toBe(3);
    expect(dry.subject_library_chunks_held).toBe(1);
    expect(dry.subject_library_documents_with_file_path).toBe(1);
    for (const documentId of [...ABOUT_A, HELD, HELD_BY_MOVED_CHUNK, HELD_BY_CHUNK_MOVED_OUT, ...KEPT]) {
      expect(await documentCount(documentId)).toBe(1);
    }
    expect(await chunkCount('doc-gym-stray')).toBe(2);
  });

  test('the purge deletes the documents about the athlete with their chunks, and is not blocked by the held one', async () => {
    const event = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.event).toBe('retention.cleanup.completed');
    expect(event.blocked_by ?? {}).toEqual({});
    expect(event.athletes).toBe(1);
    expect(event.subject_library_documents_deleted).toBe(4);
    expect(event.subject_library_chunks_deleted).toBe(6);
    expect(event.subject_library_documents_held).toBe(3);
    expect(event.subject_library_chunks_held).toBe(1);
    expect(event.subject_library_documents_with_file_path).toBe(1);
    for (const documentId of ABOUT_A) {
      expect(await documentCount(documentId)).toBe(0);
      expect(await chunkCount(documentId)).toBe(0);
    }
  });

  test('a document a surviving answer still cites is held, with its chunk and citation, by document or by a moved chunk', async () => {
    for (const documentId of [HELD, HELD_BY_MOVED_CHUNK, HELD_BY_CHUNK_MOVED_OUT]) {
      expect(await documentCount(documentId)).toBe(1);
      expect(await chunkCount(documentId)).toBe(1);
    }
    const citations = await db.query(
      'select count(*)::int as n from pilot.shadow_evidence_items where chunk_id = any($1::text[])',
      [[`${HELD}-c0`, `${HELD_BY_MOVED_CHUNK}-c0`, 'moved-out']],
    );
    expect(citations.rows[0].n).toBe(3);
  });

  test('what is held is marked subject_purged_at (F-086), and nothing else is', async () => {
    const documents = await db.query(
      `select document_id from pilot.shadow_library_documents
        where metadata ? 'subject_purged_at' order by document_id`,
    );
    expect(documents.rows.map((row) => row.document_id)).toEqual(
      [HELD_BY_CHUNK_MOVED_OUT, HELD, HELD_BY_MOVED_CHUNK].sort(),
    );
    const chunks = await db.query(
      `select chunk_id from pilot.shadow_library_chunks
        where metadata ? 'subject_purged_at' order by chunk_id`,
    );
    expect(chunks.rows.map((row) => row.chunk_id)).toEqual(
      [`${HELD_BY_CHUNK_MOVED_OUT}-c0`, `${HELD}-c0`, `${HELD_BY_MOVED_CHUNK}-c0`, 'stray-a-cited'].sort(),
    );
  });

  test("a stray chunk about the athlete under the gym's own document goes, the document stays; a cited one is held", async () => {
    const chunks = await db.query(
      'select chunk_id from pilot.shadow_library_chunks where document_id = any($1::text[]) order by chunk_id',
      [['doc-gym-stray', 'doc-gym-stray-cited']],
    );
    expect(chunks.rows.map((row) => row.chunk_id)).toEqual(['doc-gym-stray-c0', 'doc-gym-stray-cited-c0', 'stray-a-cited']);
  });

  test("another child's, the gym's own, a child inside retention's, another gym's and a near-miss id's documents all stay", async () => {
    for (const documentId of KEPT) expect(await documentCount(documentId)).toBe(1);
    for (const documentId of ['doc-b', 'doc-c-recent', 'doc-other-gym-a', 'doc-near-miss']) {
      expect(await chunkCount(documentId)).toBe(1);
    }
    expect(await chunkCount('doc-gym')).toBe(2);
  });

  test("a submission that attached the athlete's document stays, its document pointer cleared", async () => {
    const submission = await db.query(
      `select document_id from pilot.shadow_research_submissions where organization_id = $1 and submission_id = 'sub-gym'`,
      [ORG],
    );
    expect(submission.rows).toEqual([{ document_id: null }]);
  });

  test('the data_purged audit row carries the counts and no path or athlete id', async () => {
    const audit = await db.query(
      `select details from pilot.audit_events where event_type = 'data_purged' order by created_at desc limit 1`,
    );
    expect(audit.rows[0].details).toMatchObject({
      athletes_deleted: 1,
      subject_library_documents_deleted: 4,
      subject_library_chunks_deleted: 6,
      subject_library_documents_held: 3,
      subject_library_chunks_held: 1,
      subject_library_documents_with_file_path: 1,
    });
    const text = JSON.stringify(audit.rows[0].details);
    expect(text).not.toContain('library/');
    expect(text).not.toContain(ATHLETE_A);
  });

  test('an athlete whose purge is refused keeps their documents, and the run counts none', async () => {
    await insertDocument(ORG, 'doc-d', SOURCE, ATHLETE_D);
    // A video and no storage: the athlete's savepoint is rolled back
    // (STORAGE_CREDENTIAL_MISSING), the document delete with it.
    await db.query(
      `insert into pilot.video_sessions
         (video_session_id, organization_id, uploaded_by_account_id, athlete_id, title, blob_path,
          file_name, file_size_bytes, mime_type)
       values ('vid-lb-d', $1, $2, $3, 'clip', 'org-lb-1/vid-lb-d.mp4', 'clip.mp4', 5, 'video/mp4')`,
      [ORG, COACH, ATHLETE_D],
    );
    await db.query(
      `update pilot.athletes set deleted_at = now() - interval '3 years' where organization_id = $1 and athlete_id = $2`,
      [ORG, ATHLETE_D],
    );

    const event = await runCleanupScript({ PPBF_RETENTION_APPLY: 'true' });
    expect(event.blocked_by).toEqual({ STORAGE_CREDENTIAL_MISSING: 1 });
    expect(event.athletes).toBe(0);
    expect(event.subject_library_documents_deleted).toBe(0);
    expect(event.subject_library_chunks_deleted).toBe(0);
    expect(await documentCount('doc-d')).toBe(1);
    expect(await chunkCount('doc-d')).toBe(1);
  });
});
