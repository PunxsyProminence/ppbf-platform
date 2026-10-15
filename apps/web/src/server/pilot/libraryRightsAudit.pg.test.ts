// Real PostgreSQL proof of the read-only Library rights audit
// (scripts/pilot-check-library-rights.mjs; issue #1468, N6-03 PR 3). The
// script's exported check runs against a client this suite owns; its run()
// is never called. Rules under test: it counts sources by rights per shelf
// and which already hold text, counts documents marked 'indexed' with no
// completion time, prints no titles, text or account ids, and writes nothing.
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

jest.setTimeout(240_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-library-rights-audit-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const FULL_SCHEMA_HELPER_PATH = path.resolve(__dirname, '../../../scripts/lib/full-schema.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const TEST_DB_NAME = 'ppbf_test_library_rights_audit';

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

const GYM = 'org-lr-1';
const OTHER_GYM = 'org-lr-2';
const SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/pilot-check-library-rights.mjs');

interface Report {
  database: string;
  sources: Array<{
    organization_id: string;
    rights_status: string;
    sources: number;
    sources_holding_text: number;
    sources_holding_full_text: number;
  }>;
  documents: Array<{ organization_id: string; indexed_without_completion: number; with_text: number }>;
}

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let db: Client;
let checkLibraryRights: (client: Client) => Promise<Report>;

function connectionStringFor(database: string): string {
  return `postgres://${PG_USER}:${PG_PASSWORD}@localhost:${PG_PORT}/${database}`;
}

async function source(organizationId: string, sourceId: string, rights: string): Promise<void> {
  await db.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, status, rights_status, created_by_account_id, created_by_role)
     values ($1, $2, $3, 'peer_reviewed', 2, 'active', $4, 'acct-lr-admin', 'organization_admin')`,
    [sourceId, organizationId, `Title ${sourceId}`, rights],
  );
}

type DocumentState = 'pending' | 'indexed-no-time' | 'indexed';

async function document(organizationId: string, sourceId: string, documentId: string, state: DocumentState): Promise<void> {
  await db.query(
    `insert into pilot.shadow_library_documents
       (document_id, source_id, organization_id, document_name, ingest_state, index_completed_at)
     values ($1, $2, $3, $4, $5, case when $6 then now() else null end)`,
    [documentId, sourceId, organizationId, `Document ${documentId}`, state === 'pending' ? 'pending' : 'indexed', state === 'indexed'],
  );
}

/** A chunk in `documentId` that cites `citedSourceId` (often, not always, the document's own source). */
async function excerpt(organizationId: string, citedSourceId: string, documentId: string, ordinal = 1): Promise<void> {
  await db.query(
    `insert into pilot.shadow_library_chunks
       (chunk_id, document_id, source_id, organization_id, ordinal, text_content, text_kind, excerpt_locator)
     values ($1, $2, $3, $4, $5, 'A short passage.', 'excerpt', 'p. 3')`,
    [`${documentId}-chunk-${ordinal}`, documentId, citedSourceId, organizationId, ordinal],
  );
}

/**
 * Full text. Allowed by the rights guard only under an owned or open document
 * source; `legacy` writes it past the guard, as rows from before it exist.
 */
async function fullText(organizationId: string, sourceId: string, documentId: string, legacy = false): Promise<void> {
  if (legacy) await db.query(`set session_replication_role = replica`);
  try {
    await db.query(
      `insert into pilot.shadow_library_chunks
         (chunk_id, document_id, source_id, organization_id, ordinal, text_content, text_kind)
       values ($1, $2, $3, $4, 9, 'The whole text.', 'full_text')`,
      [`${documentId}-full`, documentId, sourceId, organizationId],
    );
  } finally {
    if (legacy) await db.query(`set session_replication_role = origin`);
  }
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

  await db.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, 'Punxsy Prominence', 'active'), ($2, 'Another Gym', 'active')`,
    [GYM, OTHER_GYM],
  );
  await db.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ('acct-lr-admin', 'organization_admin', $1, 'microsoft')`,
    [GYM],
  );

  await source(GYM, 'src-owned', 'ppbf_owned');
  await source(GYM, 'src-licensed', 'licensed_excerpt_only');
  await source(GYM, 'src-unknown-text', 'unknown');
  await source(GYM, 'src-unknown-empty', 'unknown');
  await source(GYM, 'src-unknown-legacy', 'unknown');
  await source(OTHER_GYM, 'src-other-unknown', 'unknown');

  await document(GYM, 'src-unknown-text', 'doc-unknown-text', 'pending');
  await excerpt(GYM, 'src-unknown-text', 'doc-unknown-text');
  // Full text under 'unknown', from before the rights guard: the urgent case.
  await document(GYM, 'src-unknown-legacy', 'doc-unknown-legacy', 'pending');
  await fullText(GYM, 'src-unknown-legacy', 'doc-unknown-legacy', true);
  await document(GYM, 'src-licensed', 'doc-licensed', 'indexed-no-time');
  await excerpt(GYM, 'src-licensed', 'doc-licensed');
  await document(GYM, 'src-owned', 'doc-owned-1', 'indexed-no-time');
  await document(GYM, 'src-owned', 'doc-owned-2', 'pending');
  await fullText(GYM, 'src-owned', 'doc-owned-2');
  // Held under src-owned (its document's source) though it CITES
  // src-unknown-empty: the text's rights are its document's.
  await excerpt(GYM, 'src-unknown-empty', 'doc-owned-2', 2);
  // Indexed with its time: not counted.
  await document(GYM, 'src-owned', 'doc-owned-3', 'indexed');
  await document(OTHER_GYM, 'src-other-unknown', 'doc-other', 'indexed-no-time');

  const scriptModule = await nativeDynamicImport(pathToFileURL(SCRIPT_PATH).href);
  checkLibraryRights = scriptModule.checkLibraryRights as typeof checkLibraryRights;
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

describe('the library rights audit counts what waits on a person (#1468 PR 3)', () => {
  test('sources by rights per shelf, and how many of them already hold text', async () => {
    const report = await checkLibraryRights(db);
    expect(report.database).toBe(TEST_DB_NAME);
    expect(report.sources).toEqual([
      { organization_id: GYM, rights_status: 'licensed_excerpt_only', sources: 1, sources_holding_text: 1, sources_holding_full_text: 0 },
      { organization_id: GYM, rights_status: 'ppbf_owned', sources: 1, sources_holding_text: 1, sources_holding_full_text: 1 },
      // src-unknown-empty is only CITED by a chunk in an owned document, so it
      // holds nothing; src-unknown-legacy holds full text from before the guard.
      { organization_id: GYM, rights_status: 'unknown', sources: 3, sources_holding_text: 2, sources_holding_full_text: 1 },
      { organization_id: OTHER_GYM, rights_status: 'unknown', sources: 1, sources_holding_text: 0, sources_holding_full_text: 0 },
    ]);
  });

  test("documents marked 'indexed' with no completion time, per shelf", async () => {
    const report = await checkLibraryRights(db);
    // doc-licensed holds text (the indexing step can complete it); doc-owned-1
    // and doc-other do not; doc-owned-3 has its time and is not counted.
    expect(report.documents).toEqual([
      { organization_id: GYM, indexed_without_completion: 2, with_text: 1 },
      { organization_id: OTHER_GYM, indexed_without_completion: 1, with_text: 0 },
    ]);
  });

  test('the audit carries counts and shelf ids only: no titles, no text, no account ids', async () => {
    const text = JSON.stringify(await checkLibraryRights(db));
    expect(text).not.toContain('Title ');
    expect(text).not.toContain('A short passage');
    expect(text).not.toContain('acct-lr-admin');
  });

  test('the audit changes nothing, and runs in a transaction Postgres refuses to write in', async () => {
    const before = await db.query(
      `select (select count(*) from pilot.shadow_library_sources)::int as s,
              (select count(*) from pilot.shadow_library_documents where index_completed_at is not null)::int as d,
              (select string_agg(rights_status, ',' order by source_id) from pilot.shadow_library_sources) as r`,
    );
    const statements: string[] = [];
    let writeRefusal: string | undefined;
    const spy: Client = Object.create(db);
    spy.query = (async (text: string, values?: unknown[]) => {
      statements.push(String(text));
      const result = await db.query(text, values);
      // Inside the audit's own transaction, Postgres itself must refuse a write.
      if (statements.length === 1) {
        await db.query('savepoint write_probe');
        try {
          await db.query('update pilot.shadow_library_sources set title = title');
        } catch (error) {
          writeRefusal = (error as { code?: string }).code;
        }
        await db.query('rollback to savepoint write_probe');
      }
      return result;
    }) as Client['query'];
    await checkLibraryRights(spy);
    expect(writeRefusal).toBe('25006'); // read_only_sql_transaction
    expect(statements[0]).toBe('BEGIN TRANSACTION READ ONLY');
    expect(statements.every((statement) => /^\s*(begin transaction read only|select|commit)\b/i.test(statement))).toBe(true);
    const after = await db.query(
      `select (select count(*) from pilot.shadow_library_sources)::int as s,
              (select count(*) from pilot.shadow_library_documents where index_completed_at is not null)::int as d,
              (select string_agg(rights_status, ',' order by source_id) from pilot.shadow_library_sources) as r`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
