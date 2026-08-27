// Real PostgreSQL-backed contract test for the retraction surveillance
// migration (pilot.source_retraction_checks, pilot.v_source_retraction_status,
// pilot.v_sources_needing_retraction_check, and the retrieval_suppressed
// family of columns on pilot.shadow_library_sources) and
// sourceRetractionChecks.ts's functions running against a real transaction.
//
// What needs proving, and cannot be proven by reading SQL or a mocked-query
// unit test:
//
// 1. pilot_src_retraction_evidence holds: a retracted/withdrawn/expression_of_concern
//    row with an empty evidence_snippet is rejected -- an unevidenced flag is a rumour.
// 2. pilot_src_retraction_disposition holds: a disposition set without an
//    acknowledger and a >=15 character note is rejected.
// 3. pilot_library_sources_suppression_reason holds: retrieval_suppressed=true
//    without a >=10 character reason and a named suppressor is rejected.
// 4. recordRetractionDisposition and suppressSource enforce those same floors
//    up front, and actually write what they claim to.
// 5. pilot.v_source_retraction_status computes action_signal correctly,
//    including dependent_chunks (what was actually built on the source).
// 6. pilot.v_sources_needing_retraction_check expires a clear result after
//    90 days -- retraction is a moving target.
// 7. Suppressing a source actually removes it from searchShadowLibrary --
//    the whole point of retrieval_suppressed.
// 8. The readiness check actually fails when the migration did not land.
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
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

let activeClient: Client | null = null;

jest.mock('./db', () => ({
  query: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows;
  }),
  queryOne: jest.fn(async (text: string, params: unknown[] = []) => {
    if (!activeClient) throw new Error('test bug: no active embedded client');
    const result = await activeClient.query(text, params);
    return result.rows[0] ?? null;
  }),
}));

import { searchShadowLibrary } from './shadowLibrary';
import {
  getSourceRetractionStatus,
  getSourcesNeedingRetractionCheck,
  listSourceRetractionChecks,
  recordRetractionDisposition,
  suppressSource,
  unsuppressSource,
} from './sourceRetractionChecks';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-retraction-checks-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_retraction_surveillance_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-retraction-surveillance-migration.mjs',
);
const SCHEMA_FILES = ['pilot_slice_postgres.sql', 'pilot_slice_postgres_data_retention_deletion_migration.sql', 'pilot_slice_postgres_shadow_evidence_migration.sql'];

const ORG_A = 'org-retractionchecks-a';
const SOURCE_A = 'source-retractionchecks-a';
const REVIEWER_A = 'acct-retractionchecks-reviewer-a';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string[];
let migrationSql: string;
let applyMigrationTransaction: (client: Client, sql: string) => Promise<void>;

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
  for (const sql of baseSchemaSql) {
    await client.query(sql);
  }

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_A],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'organization_admin', $2, 'microsoft') on conflict do nothing`,
    [REVIEWER_A, ORG_A],
  );
  await client.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, status,
        approval_state, verification_state, approved_by_account_id, approved_at,
        verified_by_account_id, verified_at)
     values ($1, $2, 'The MMR Vaccine and Autism (retracted)', 'peer_reviewed', 1, 'active',
             'approved', 'verified', $3, now(), $3, now())`,
    [SOURCE_A, ORG_A, REVIEWER_A],
  );

  activeClient = client;
  return client;
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

  baseSchemaSql = await Promise.all(
    SCHEMA_FILES.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    client: Client,
    sql: string,
  ) => Promise<void>;
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
});

async function insertCheck(client: Client, overrides: Record<string, unknown> = {}) {
  const row = {
    organization_id: ORG_A,
    retraction_check_id: `rtc-${Math.random().toString(36).slice(2)}`,
    source_id: SOURCE_A,
    identifier_kind: 'pmid',
    identifier_value: '9500320',
    resolver: 'ncbi_eutils',
    status: 'retracted',
    notice_type: 'Retracted Publication',
    notice_doi: null,
    notice_date: null,
    notice_source: 'pubmed_pubtype',
    evidence_snippet: 'pubtype: retracted publication',
    checker_version: 'retraction-check/1.0.0',
    ...overrides,
  };
  const result = await client.query(
    `insert into pilot.source_retraction_checks
       (organization_id, retraction_check_id, source_id, identifier_kind, identifier_value, resolver,
        status, notice_type, notice_doi, notice_date, notice_source, evidence_snippet, checker_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     returning retraction_check_id`,
    [
      row.organization_id, row.retraction_check_id, row.source_id, row.identifier_kind,
      row.identifier_value, row.resolver, row.status, row.notice_type, row.notice_doi,
      row.notice_date, row.notice_source, row.evidence_snippet, row.checker_version,
    ],
  );
  return result.rows[0].retraction_check_id as string;
}

describe('retraction surveillance migration readiness against real Postgres', () => {
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /RETRACTION_SURVEILLANCE_NOT_READY/,
      );
      const table = await client.query(`select to_regclass('pilot.source_retraction_checks') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('re-running is a no-op: no duplicate constraints or columns', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint
         where conname in ('pilot_src_retraction_pkey', 'pilot_src_retraction_evidence',
                            'pilot_src_retraction_disposition', 'pilot_library_sources_suppression_reason')`,
      );
      expect(constraints.rows[0].n).toBe(4);

      const columns = await client.query(
        `select count(*)::int as n from information_schema.columns
         where table_schema = 'pilot' and table_name = 'shadow_library_sources'
           and column_name in ('retrieval_suppressed', 'suppression_reason', 'suppressed_at',
                                'suppressed_by_account_id')`,
      );
      expect(columns.rows[0].n).toBe(4);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_src_retraction_evidence', () => {
  test('a retracted row with an empty evidence_snippet is rejected', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_no_evidence');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await expect(insertCheck(client, { evidence_snippet: '' })).rejects.toThrow(
        /pilot_src_retraction_evidence/,
      );
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a clear row needs no evidence at all', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_clear_no_evidence');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await expect(
        insertCheck(client, { status: 'clear', notice_type: null, evidence_snippet: '' }),
      ).resolves.toBeDefined();
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_src_retraction_disposition', () => {
  test('a disposition set directly in SQL without an acknowledger is rejected', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_disposition_no_ack');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const checkId = await insertCheck(client);
      await expect(
        client.query(
          `update pilot.source_retraction_checks set disposition = 'suppress_source' where retraction_check_id = $1`,
          [checkId],
        ),
      ).rejects.toThrow(/pilot_src_retraction_disposition/);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('recordRetractionDisposition refuses a note under 15 characters before it ever reaches SQL', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_disposition_short_note');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const checkId = await insertCheck(client);
      await expect(
        recordRetractionDisposition({
          organizationId: ORG_A,
          retractionCheckId: checkId,
          disposition: 'suppress_source',
          dispositionNote: 'too short',
          acknowledgedByAccountId: REVIEWER_A,
          actorRole: 'organization_admin',
        }),
      ).rejects.toThrow('RETRACTION_DISPOSITION_NOTE_TOO_SHORT');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('recordRetractionDisposition with a real note is accepted and recorded', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_disposition_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const checkId = await insertCheck(client);
      const updated = await recordRetractionDisposition({
        organizationId: ORG_A,
        retractionCheckId: checkId,
        disposition: 'suppress_source',
        dispositionNote: 'Retracted for fraudulent data; removing from retrieval immediately.',
        acknowledgedByAccountId: REVIEWER_A,
        actorRole: 'organization_admin',
      });
      expect(updated.disposition).toBe('suppress_source');
      expect(updated.acknowledged_by_account_id).toBe(REVIEWER_A);
      expect(updated.acknowledged_at).not.toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('recordRetractionDisposition refuses a coach role', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_disposition_forbidden');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const checkId = await insertCheck(client);
      await expect(
        recordRetractionDisposition({
          organizationId: ORG_A,
          retractionCheckId: checkId,
          disposition: 'suppress_source',
          dispositionNote: 'Retracted for fraudulent data; removing from retrieval immediately.',
          acknowledgedByAccountId: REVIEWER_A,
          actorRole: 'coach',
        }),
      ).rejects.toThrow('Forbidden');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_library_sources_suppression_reason', () => {
  test('retrieval_suppressed=true set directly in SQL without a reason is rejected', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_suppress_no_reason');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await expect(
        client.query(
          `update pilot.shadow_library_sources set retrieval_suppressed = true where source_id = $1`,
          [SOURCE_A],
        ),
      ).rejects.toThrow(/pilot_library_sources_suppression_reason/);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('suppressSource refuses a reason under 10 characters before it ever reaches SQL', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_suppress_short_reason');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await expect(
        suppressSource({
          organizationId: ORG_A,
          sourceId: SOURCE_A,
          reason: 'too short',
          suppressedByAccountId: REVIEWER_A,
          actorRole: 'organization_admin',
        }),
      ).rejects.toThrow('SOURCE_SUPPRESSION_REASON_TOO_SHORT');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('suppressSource with a real reason is accepted, and unsuppressSource reverses it', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_suppress_ok');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await suppressSource({
        organizationId: ORG_A,
        sourceId: SOURCE_A,
        reason: 'Retracted by the journal; removing from retrieval.',
        suppressedByAccountId: REVIEWER_A,
        actorRole: 'organization_admin',
      });

      const suppressed = await client.query(
        `select retrieval_suppressed, suppression_reason, suppressed_by_account_id
         from pilot.shadow_library_sources where source_id = $1`,
        [SOURCE_A],
      );
      expect(suppressed.rows[0].retrieval_suppressed).toBe(true);
      expect(suppressed.rows[0].suppression_reason).toContain('Retracted by the journal');
      expect(suppressed.rows[0].suppressed_by_account_id).toBe(REVIEWER_A);

      await unsuppressSource({ organizationId: ORG_A, sourceId: SOURCE_A, actorRole: 'organization_admin' });
      const unsuppressed = await client.query(
        `select retrieval_suppressed from pilot.shadow_library_sources where source_id = $1`,
        [SOURCE_A],
      );
      expect(unsuppressed.rows[0].retrieval_suppressed).toBe(false);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('suppressSource on a source in another organization is not found', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_suppress_not_found');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await expect(
        suppressSource({
          organizationId: 'org-someone-else',
          sourceId: SOURCE_A,
          reason: 'Retracted by the journal; removing from retrieval.',
          suppressedByAccountId: REVIEWER_A,
          actorRole: 'organization_admin',
        }),
      ).rejects.toThrow('SOURCE_NOT_FOUND');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot.v_source_retraction_status', () => {
  test('a retracted source with no disposition is urgent_unhandled, with its dependent chunk count', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_urgent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertCheck(client);

      const documentId = 'doc-retractionchecks-a';
      await client.query(
        `insert into pilot.shadow_library_documents
           (document_id, source_id, organization_id, document_name, ingest_state, index_completed_at,
            approval_state, verification_state, approved_by_account_id, approved_at,
            verified_by_account_id, verified_at)
         values ($1, $2, $3, 'The MMR Vaccine and Autism.pdf', 'indexed', now(), 'approved', 'verified',
                 $4, now(), $4, now())`,
        [documentId, SOURCE_A, ORG_A, REVIEWER_A],
      );
      await client.query(
        `insert into pilot.shadow_library_chunks
           (chunk_id, document_id, source_id, organization_id, ordinal, text_content)
         values ('chunk-retractionchecks-1', $1, $2, $3, 0, 'Some chunk text.'),
                ('chunk-retractionchecks-2', $1, $2, $3, 1, 'Some more chunk text.')`,
        [documentId, SOURCE_A, ORG_A],
      );

      const status = await getSourceRetractionStatus(ORG_A);
      expect(status).toHaveLength(1);
      expect(status[0].status).toBe('retracted');
      expect(status[0].action_signal).toBe('urgent_unhandled');
      expect(status[0].dependent_chunks).toBe(2);

      const urgentOnly = await getSourceRetractionStatus(ORG_A, { actionSignal: 'urgent_unhandled' });
      expect(urgentOnly).toHaveLength(1);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('disposing of a retracted finding moves it to handled', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_handled');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const checkId = await insertCheck(client);
      await recordRetractionDisposition({
        organizationId: ORG_A,
        retractionCheckId: checkId,
        disposition: 'suppress_source',
        dispositionNote: 'Retracted for fraudulent data; removing from retrieval immediately.',
        acknowledgedByAccountId: REVIEWER_A,
        actorRole: 'organization_admin',
      });

      const status = await getSourceRetractionStatus(ORG_A);
      expect(status[0].action_signal).toBe('handled');
      expect(status[0].disposition).toBe('suppress_source');

      const history = await listSourceRetractionChecks(ORG_A, SOURCE_A);
      expect(history).toHaveLength(1);
      expect(history[0].disposition).toBe('suppress_source');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a correction is informational until a human disposes of it', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_informational');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertCheck(client, {
        status: 'corrected', notice_type: 'Published Erratum', evidence_snippet: 'pubtype: published erratum',
      });

      const status = await getSourceRetractionStatus(ORG_A);
      expect(status[0].action_signal).toBe('informational');
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot.v_sources_needing_retraction_check', () => {
  test('a never-checked active source is never_checked', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_never_checked');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const queue = await getSourcesNeedingRetractionCheck(ORG_A);
      expect(queue).toHaveLength(1);
      expect(queue[0].source_id).toBe(SOURCE_A);
      expect(queue[0].check_state).toBe('never_checked');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a clear result older than 90 days is stale_recheck_due -- a past clear result expires', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_stale');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const checkId = await insertCheck(client, { status: 'clear', notice_type: null, evidence_snippet: '' });
      await client.query(
        `update pilot.source_retraction_checks set checked_at = now() - interval '120 days'
         where retraction_check_id = $1`,
        [checkId],
      );

      const queue = await getSourcesNeedingRetractionCheck(ORG_A);
      expect(queue).toHaveLength(1);
      expect(queue[0].check_state).toBe('stale_recheck_due');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a recent clear result is current and drops out of the queue', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_recent_clear');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertCheck(client, { status: 'clear', notice_type: null, evidence_snippet: '' });

      const queue = await getSourcesNeedingRetractionCheck(ORG_A);
      expect(queue).toHaveLength(0);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a not_checkable source is excluded from the queue entirely', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_not_checkable');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertCheck(client, {
        identifier_kind: 'none', identifier_value: '', resolver: 'not_attempted',
        status: 'not_checkable', notice_type: null, evidence_snippet: '',
      });

      const queue = await getSourcesNeedingRetractionCheck(ORG_A);
      expect(queue).toHaveLength(0);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('suppression actually removes a source from retrieval', () => {
  test('a suppressed source no longer appears in searchShadowLibrary', async () => {
    const client = await freshDatabase('ppbf_test_retractionchecks_search_exclusion');
    try {
      await applyMigrationTransaction(client, migrationSql);

      const documentId = 'doc-retractionchecks-search';
      await client.query(
        `insert into pilot.shadow_library_documents
           (document_id, source_id, organization_id, document_name, ingest_state, index_completed_at,
            approval_state, verification_state, approved_by_account_id, approved_at,
            verified_by_account_id, verified_at)
         values ($1, $2, $3, 'The MMR Vaccine and Autism.pdf', 'indexed', now(), 'approved', 'verified',
                 $4, now(), $4, now())`,
        [documentId, SOURCE_A, ORG_A, REVIEWER_A],
      );
      await client.query(
        `insert into pilot.shadow_library_chunks
           (chunk_id, document_id, source_id, organization_id, ordinal, text_content)
         values ('chunk-retractionchecks-search', $1, $2, $3, 0, 'measles mumps rubella vaccine study text')`,
        [documentId, SOURCE_A, ORG_A],
      );

      const before = await searchShadowLibrary({
        organizationId: ORG_A,
        actorAccountId: REVIEWER_A,
        actorRole: 'organization_admin',
        scope: 'scoped',
        queryText: 'measles mumps rubella vaccine',
      });
      expect(before.some((r) => r.source_id === SOURCE_A)).toBe(true);

      await suppressSource({
        organizationId: ORG_A,
        sourceId: SOURCE_A,
        reason: 'Retracted by the journal; removing from retrieval.',
        suppressedByAccountId: REVIEWER_A,
        actorRole: 'organization_admin',
      });

      const after = await searchShadowLibrary({
        organizationId: ORG_A,
        actorAccountId: REVIEWER_A,
        actorRole: 'organization_admin',
        scope: 'scoped',
        queryText: 'measles mumps rubella vaccine',
      });
      expect(after.some((r) => r.source_id === SOURCE_A)).toBe(false);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
