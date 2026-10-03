// Real PostgreSQL-backed test for the evidence-bundle insert's re-check.
//
// retrieveShadowEvidenceBundle searches, then saves what it found. The save
// re-checks each chunk's source and document inside its own insert, so a
// source that stopped being servable in between is refused rather than cited.
// The re-check used to cover approval and verification but not retraction
// suppression (suppressSource flips only retrieval_suppressed and leaves the
// approvals standing), so a source retracted between search and save was
// still saved as evidence. shadowEvidence.test.ts mocks the database and
// cannot see a SQL predicate; this file runs the real function against real
// rows.
//
// './db' is mocked to route into the embedded server (the same pattern as
// shadowLibraryCoverage.pg.test.ts). './shadowLibrary' is the real module;
// only searchShadowLibrary is wrapped, so a test can retract the source in the
// gap between the real search returning and the real insert running.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER connects to production or staging.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';

import { Client } from 'pg';

let activeClient: Client | null = null;
let afterSearch: (() => Promise<void>) | null = null;

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
  withTransaction: jest.fn(async (fn: (client: Client) => Promise<unknown>) => {
    const client = requireClient();
    await client.query('begin');
    try {
      const value = await fn(client);
      await client.query('commit');
      return value;
    } catch (error) {
      await client.query('rollback');
      throw error;
    }
  }),
}));

jest.mock('./shadowLibrary', () => {
  const actual = jest.requireActual('./shadowLibrary');
  return {
    ...actual,
    searchShadowLibrary: jest.fn(async (...args: unknown[]) => {
      const rows = await actual.searchShadowLibrary(...args);
      if (afterSearch) await afterSearch();
      return rows;
    }),
  };
});

import { retrieveShadowEvidenceBundle } from './shadowEvidence';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-shadow-evidence-suppression-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const ORG_ID = 'org-evidence';
const ADMIN_ID = 'acct-evidence-admin';
const SOURCE_ID = 'source-evidence';
const QUERY = 'southpaw footwork pivot';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let schemaSql: string[];

// The list shadowLibraryCoverage.pg.test.ts applies, in its order: the columns
// search and the insert read (approval, verification, retraction suppression,
// library_organization_id) arrive across these files.
const SCHEMA_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_data_retention_deletion_migration.sql',
  'pilot_slice_postgres_shadow_runtime_migration.sql',
  'pilot_slice_postgres_shadow_evidence_migration.sql',
  'pilot_slice_postgres_shadow_chunk_embedding_migration.sql',
  'pilot_slice_postgres_retraction_surveillance_migration.sql',
  'pilot_slice_postgres_platform_library_scope_migration.sql',
];

const actor = {
  accountId: ADMIN_ID,
  organizationId: ORG_ID,
  athleteId: null,
  role: 'organization_admin' as const,
};

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

/** A fresh database holding one servable source, document and chunk. */
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
  await client.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, status,
        approval_state, verification_state,
        approved_by_account_id, approved_at, verified_by_account_id, verified_at)
     values ($1, $2, $1, 'article', 1, 'active', 'approved', 'verified', $3, now(), $3, now())`,
    [SOURCE_ID, ORG_ID, ADMIN_ID],
  );
  await client.query(
    `insert into pilot.shadow_library_documents
       (document_id, source_id, organization_id, document_name, ingest_state, index_completed_at,
        approval_state, verification_state,
        approved_by_account_id, approved_at, verified_by_account_id, verified_at)
     values ('doc-evidence', $1, $2, 'doc-evidence', 'indexed', now(), 'approved', 'verified', $3, now(), $3, now())`,
    [SOURCE_ID, ORG_ID, ADMIN_ID],
  );
  await client.query(
    `insert into pilot.shadow_library_chunks
       (chunk_id, document_id, source_id, organization_id, ordinal, text_content)
     values ('chunk-evidence', 'doc-evidence', $1, $2, 0, 'Southpaw footwork: pivot off the lead foot.')`,
    [SOURCE_ID, ORG_ID],
  );
  return client;
}

/** What suppressSource writes: the flag and its reason; the approvals stay. */
async function retractSource(client: Client): Promise<void> {
  await client.query(
    `update pilot.shadow_library_sources
        set retrieval_suppressed = true,
            suppression_reason = 'Retracted by the publisher (test fixture).',
            suppressed_at = now(),
            suppressed_by_account_id = $3
      where organization_id = $1 and source_id = $2`,
    [ORG_ID, SOURCE_ID, ADMIN_ID],
  );
}

async function savedItemCount(client: Client): Promise<number> {
  const result = await client.query<{ n: string }>(
    'select count(*)::text as n from pilot.shadow_evidence_items',
  );
  return Number(result.rows[0].n);
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
  afterSearch = null;
  if (activeClient) await activeClient.end().catch(() => {});
  activeClient = null;
});

describe('the evidence-bundle insert re-checks what search checked', () => {
  it('saves a servable source as evidence (control: the fixture is citable)', async () => {
    activeClient = await freshDatabase('evidence_control');

    const bundle = await retrieveShadowEvidenceBundle({ actor, queryText: QUERY });

    expect(bundle.availability).toBe('available');
    expect(bundle.items.map((item) => item.sourceId)).toEqual([SOURCE_ID]);
    expect(await savedItemCount(activeClient)).toBe(1);
  });

  it('refuses a source retracted between search and save, and saves nothing', async () => {
    activeClient = await freshDatabase('evidence_retracted');
    const client = activeClient;
    afterSearch = () => retractSource(client);

    await expect(retrieveShadowEvidenceBundle({ actor, queryText: QUERY }))
      .rejects.toThrow('SHADOW_EVIDENCE_QUALIFICATION_CHANGED');
    expect(await savedItemCount(client)).toBe(0);
  });
});
