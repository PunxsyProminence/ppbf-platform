// Real PostgreSQL proof that SHADOW shows a cited passage only within the
// rights rule (OD-2026-10-08-005 A-Q11, ruling 4; OD-2026-10-02-013 4A;
// OD-2026-10-03-002 Q3): the REAL retrieveShadowEvidenceBundle and
// publicEvidenceCitations for a live answer, and the REAL
// loadConversationMessages for a reopened one. A passage is shown only when
// both the source it cites and the source of the document it was cut from
// are ppbf_owned or open_licence; everything else stays a title.
//
// Spins up the disposable local-only embedded Postgres the other suites use.
// It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-passage-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_shadow_passage';

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

const ORG = 'org-pt-1';
const ADMIN = 'acct-pt-admin';
const QUERY = 'southpaw footwork pivot';

const actor = { accountId: ADMIN, organizationId: ORG, athleteId: null, role: 'organization_admin' as const };

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let evidence: typeof import('./shadowEvidence');
let conversations: typeof import('./shadowConversations');

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function source(sourceId: string, rights: string): Promise<void> {
  await db.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, status, rights_status,
        approval_state, verification_state, approved_by_account_id, approved_at, verified_by_account_id, verified_at)
     values ($1, $2, $3, 'peer_reviewed', 1, 'active', $4, 'approved', 'verified', $5, now(), $5, now())`,
    [sourceId, ORG, `Title ${sourceId}`, rights, ADMIN],
  );
}

async function document(documentId: string, sourceId: string): Promise<void> {
  await db.query(
    `insert into pilot.shadow_library_documents
       (document_id, source_id, organization_id, document_name, ingest_state, index_completed_at,
        approval_state, verification_state, approved_by_account_id, approved_at, verified_by_account_id, verified_at)
     values ($1, $2, $3, $1, 'indexed', now(), 'approved', 'verified', $4, now(), $4, now())`,
    [documentId, sourceId, ORG, ADMIN],
  );
}

/** A passage in `documentId` citing `citedSourceId`; an excerpt unless the document's source may hold full text. */
async function chunk(chunkId: string, documentId: string, citedSourceId: string, ordinal: number, full: boolean): Promise<void> {
  await db.query(
    `insert into pilot.shadow_library_chunks
       (chunk_id, document_id, source_id, organization_id, ordinal, text_content, text_kind, excerpt_locator)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [chunkId, documentId, citedSourceId, ORG, ordinal, `Southpaw footwork pivot: passage ${chunkId}.`,
      full ? 'full_text' : 'excerpt', full ? null : 'p. 4'],
  );
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
  await db.query(`insert into pilot.accounts (account_id, role, organization_id, auth_provider) values ($1, 'organization_admin', $2, 'microsoft')`, [ADMIN, ORG]);

  await source('src-owned', 'ppbf_owned');
  await source('src-open', 'open_licence');
  await source('src-licensed', 'licensed_excerpt_only');
  await source('src-unknown', 'unknown');
  await document('doc-owned', 'src-owned');
  await document('doc-licensed', 'src-licensed');
  // Shown: cited source and document source both PPBF-owned.
  await chunk('chunk-owned', 'doc-owned', 'src-owned', 1, true);
  // Not shown: the document is owned but the passage cites a source of unknown rights.
  await chunk('chunk-cites-unknown', 'doc-owned', 'src-unknown', 2, true);
  // Not shown: a licensed excerpt.
  await chunk('chunk-licensed', 'doc-licensed', 'src-licensed', 1, false);
  // Not shown: it cites an open source, but its text was cut from a licensed document.
  await chunk('chunk-open-in-licensed', 'doc-licensed', 'src-open', 2, false);

  process.env.AZURE_POSTGRES_CONNECTION_STRING = connectionStringFor(TEST_DB_NAME);
  process.env.PPBF_POSTGRES_DISABLE_SSL = 'true';
  evidence = await import('./shadowEvidence');
  conversations = await import('./shadowConversations');
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

async function citedBundle() {
  const bundle = await evidence.retrieveShadowEvidenceBundle({ actor, queryText: QUERY });
  const byChunk = new Map(bundle.items.map((item) => [item.chunkId, item.evidenceId]));
  return { bundle, byChunk };
}

describe('SHADOW shows a cited passage only within the rights rule (OD-2026-10-08-005 A-Q11)', () => {
  test('a live answer carries the passage of an owned source, and titles only for the rest', async () => {
    const { bundle, byChunk } = await citedBundle();
    expect([...byChunk.keys()].sort()).toEqual(['chunk-cites-unknown', 'chunk-licensed', 'chunk-open-in-licensed', 'chunk-owned']);

    const citations = evidence.publicEvidenceCitations(bundle, bundle.items.map((item) => item.evidenceId));
    const excerptOf = (chunkId: string) => citations.find((citation) => citation.evidenceId === byChunk.get(chunkId))?.excerpt;

    expect(excerptOf('chunk-owned')).toBe('Southpaw footwork pivot: passage chunk-owned.');
    expect(excerptOf('chunk-cites-unknown')).toBeUndefined();
    expect(excerptOf('chunk-licensed')).toBeUndefined();
    expect(excerptOf('chunk-open-in-licensed')).toBeUndefined();
    // A title-only citation does not carry the key at all.
    const licensed = citations.find((citation) => citation.evidenceId === byChunk.get('chunk-licensed'));
    expect(licensed).not.toHaveProperty('excerpt');
    expect(licensed?.sourceTitle).toBe('Title src-licensed');
  });

  test('a reopened conversation shows the same passages, with the rights read again', async () => {
    const { bundle, byChunk } = await citedBundle();
    const conversationId = randomUUID();
    const messageId = randomUUID();
    await db.query(
      `insert into pilot.shadow_chat_sessions (conversation_id, organization_id, account_id) values ($1, $2, $3)`,
      [conversationId, ORG, ADMIN],
    );
    await db.query(
      `insert into pilot.shadow_chat_messages (message_id, conversation_id, organization_id, account_id, role, content, response_state)
       values ($1, $2, $3, $4, 'assistant', 'An answer.', 'ok')`,
      [messageId, conversationId, ORG, ADMIN],
    );
    for (const [index, item] of bundle.items.entries()) {
      await db.query(
        `insert into pilot.shadow_message_citations (assistant_message_id, evidence_id, bundle_id, organization_id, account_id, ordinal)
         values ($1, $2, $3, $4, $5, $6)`,
        [messageId, item.evidenceId, bundle.bundleId, ORG, ADMIN, index + 1],
      );
    }

    const read = async () => {
      const [message] = await conversations.loadConversationMessages({ actor, conversationId });
      return (chunkId: string) => (message.citations ?? []).find((citation) => citation.evidenceId === byChunk.get(chunkId));
    };

    let citationOf = await read();
    expect(citationOf('chunk-owned')?.excerpt).toBe('Southpaw footwork pivot: passage chunk-owned.');
    expect(citationOf('chunk-cites-unknown')).not.toHaveProperty('excerpt');
    expect(citationOf('chunk-licensed')).not.toHaveProperty('excerpt');
    expect(citationOf('chunk-open-in-licensed')).not.toHaveProperty('excerpt');
    expect(citationOf('chunk-licensed')?.sourceTitle).toBe('Title src-licensed');

    // A curator classifies the unknown source as PPBF-owned: the passage that
    // cites it, in an owned document, is now within the rule on the next read.
    await db.query(`update pilot.shadow_library_sources set rights_status = 'ppbf_owned' where source_id = 'src-unknown'`);
    citationOf = await read();
    expect(citationOf('chunk-cites-unknown')?.excerpt).toBe('Southpaw footwork pivot: passage chunk-cites-unknown.');
    await db.query(`update pilot.shadow_library_sources set rights_status = 'unknown' where source_id = 'src-unknown'`);
  });
});
