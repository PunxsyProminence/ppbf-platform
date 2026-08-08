// Real PostgreSQL-backed contract test for the citation verification
// migration (pilot.source_citation_checks, pilot.v_source_citation_status,
// pilot.v_sources_needing_citation_check) and sourceCitationChecks.ts's
// read functions running against a real transaction.
//
// What needs proving, and cannot be proven by reading SQL or a mocked-query
// unit test:
//
// 1. pilot_scc_mismatch_detail holds: a resolved_title_mismatch row with no
//    retrieved_title is rejected -- an unevidenced mismatch is not adjudicable.
// 2. pilot_scc_resolver holds: a resolved_title_match/mismatch/unknown row
//    claiming resolver='not_attempted' is rejected.
// 3. A source with neither PMID nor DOI can still record outcome='no_identifier'
//    with resolver='not_attempted' -- this is a valid state, never a failure.
// 4. resolver_unavailable never requires a retrieved_title -- a rate limit is
//    not a finding about the source.
// 5. pilot.v_source_citation_status maps every outcome to the right
//    review_signal, and never advances shadow_library_sources.verification_state.
// 6. The readiness check actually fails when the migration did not land.
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

import {
  getSourceCitationStatus,
  getSourcesNeedingCitationCheck,
  listSourceCitationChecks,
} from './sourceCitationChecks';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-citation-checks-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_source_citation_checks_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-source-citation-checks-migration.mjs',
);
const SCHEMA_FILES = ['pilot_slice_postgres.sql', 'pilot_slice_postgres_shadow_evidence_migration.sql'];

const ORG_A = 'org-citationchecks-a';
const SOURCE_A = 'source-citationchecks-a';

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
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, status,
        approval_state, verification_state)
     values ($1, $2, 'A Study of Sparring Exposure', 'peer_reviewed', 2, 'active',
             'pending_review', 'unverified')`,
    [SOURCE_A, ORG_A],
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
    check_id: `chk-${Math.random().toString(36).slice(2)}`,
    source_id: SOURCE_A,
    identifier_kind: 'pmid',
    identifier_value: '9500320',
    resolver: 'ncbi_eutils',
    outcome: 'resolved_title_match',
    retrieved_title: 'A Study of Sparring Exposure',
    retrieved_year: '2021',
    retrieved_container: 'Journal of Boxing Science',
    match_method: 'title_overlap',
    match_score: 0.9,
    checker_version: 'citation-check/1.0.0',
    detail: '',
    ...overrides,
  };
  return client.query(
    `insert into pilot.source_citation_checks
       (organization_id, check_id, source_id, identifier_kind, identifier_value, resolver, outcome,
        retrieved_title, retrieved_year, retrieved_container, match_method, match_score,
        checker_version, detail)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      row.organization_id, row.check_id, row.source_id, row.identifier_kind, row.identifier_value,
      row.resolver, row.outcome, row.retrieved_title, row.retrieved_year, row.retrieved_container,
      row.match_method, row.match_score, row.checker_version, row.detail,
    ],
  );
}

describe('source citation checks migration readiness against real Postgres', () => {
  test('the readiness check REFUSES a database where the migration never ran', async () => {
    const client = await freshDatabase('ppbf_test_citationchecks_readiness_negative');
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /SOURCE_CITATION_CHECKS_NOT_READY/,
      );
      const table = await client.query(`select to_regclass('pilot.source_citation_checks') as t`);
      expect(table.rows[0].t).toBeNull();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('re-running is a no-op: no duplicate constraints', async () => {
    const client = await freshDatabase('ppbf_test_citationchecks_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const constraints = await client.query(
        `select count(*)::int as n from pg_constraint
         where conname in ('pilot_source_citation_checks_pkey', 'pilot_scc_mismatch_detail', 'pilot_scc_resolver')`,
      );
      expect(constraints.rows[0].n).toBe(3);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_scc_mismatch_detail', () => {
  test('a resolved_title_mismatch row with no retrieved_title is rejected', async () => {
    const client = await freshDatabase('ppbf_test_citationchecks_mismatch_no_title');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await expect(
        insertCheck(client, { outcome: 'resolved_title_mismatch', retrieved_title: null }),
      ).rejects.toThrow(/pilot_scc_mismatch_detail/);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a resolved_title_mismatch row WITH a retrieved_title is accepted', async () => {
    const client = await freshDatabase('ppbf_test_citationchecks_mismatch_with_title');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await expect(
        insertCheck(client, {
          outcome: 'resolved_title_mismatch',
          retrieved_title: 'Molecular pathways in unrelated crustacean biology',
          match_score: 0.02,
        }),
      ).resolves.toBeDefined();
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot_scc_resolver', () => {
  test('a resolved_title_match row claiming resolver=not_attempted is rejected', async () => {
    const client = await freshDatabase('ppbf_test_citationchecks_resolver_not_attempted');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await expect(
        insertCheck(client, { outcome: 'resolved_title_match', resolver: 'not_attempted' }),
      ).rejects.toThrow(/pilot_scc_resolver/);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a source with neither PMID nor DOI records no_identifier, never a failure', async () => {
    const client = await freshDatabase('ppbf_test_citationchecks_no_identifier');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await expect(
        insertCheck(client, {
          identifier_kind: 'none', identifier_value: '', resolver: 'not_attempted',
          outcome: 'no_identifier', retrieved_title: null, retrieved_year: null,
          retrieved_container: null, match_method: 'none', match_score: null,
          detail: 'no PMID or DOI on this source',
        }),
      ).resolves.toBeDefined();
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a transient failure records resolver_unavailable without needing a retrieved_title', async () => {
    const client = await freshDatabase('ppbf_test_citationchecks_resolver_unavailable');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await expect(
        insertCheck(client, {
          resolver: 'ncbi_eutils', outcome: 'resolver_unavailable', retrieved_title: null,
          retrieved_year: null, retrieved_container: null, match_method: 'none', match_score: null,
          detail: 'resolver returned a transient error after retries; not a finding about the source',
        }),
      ).resolves.toBeDefined();
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot.v_source_citation_status', () => {
  test('maps outcomes to review_signal and never claims verification_state changed', async () => {
    const client = await freshDatabase('ppbf_test_citationchecks_status_view');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertCheck(client, {
        outcome: 'resolved_title_mismatch',
        retrieved_title: 'Molecular pathways in unrelated crustacean biology',
      });

      const status = await getSourceCitationStatus(ORG_A);
      expect(status).toHaveLength(1);
      expect(status[0].outcome).toBe('resolved_title_mismatch');
      expect(status[0].review_signal).toBe('needs_adjudication');
      // The check ran, but the source's own verification_state must be untouched --
      // a resolved identifier is not reviewer approval.
      expect(status[0].verification_state).toBe('unverified');
      expect(status[0].approval_state).toBe('pending_review');

      const filtered = await getSourceCitationStatus(ORG_A, { reviewSignal: 'needs_adjudication' });
      expect(filtered).toHaveLength(1);
      const noneMatching = await getSourceCitationStatus(ORG_A, { reviewSignal: 'ok' });
      expect(noneMatching).toHaveLength(0);
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('only the latest check per source is surfaced', async () => {
    const client = await freshDatabase('ppbf_test_citationchecks_latest_only');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertCheck(client, { outcome: 'unresolved', resolver: 'not_attempted', retrieved_title: null, retrieved_year: null, retrieved_container: null, match_method: 'none', match_score: null });
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      await insertCheck(client, { outcome: 'resolved_title_match' });

      const status = await getSourceCitationStatus(ORG_A);
      expect(status).toHaveLength(1);
      expect(status[0].outcome).toBe('resolved_title_match');
      expect(status[0].review_signal).toBe('ok');

      const history = await listSourceCitationChecks(ORG_A, SOURCE_A);
      expect(history).toHaveLength(2);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});

describe('pilot.v_sources_needing_citation_check', () => {
  test('a never-checked active source is never_checked', async () => {
    const client = await freshDatabase('ppbf_test_citationchecks_never_checked');
    try {
      await applyMigrationTransaction(client, migrationSql);
      const queue = await getSourcesNeedingCitationCheck(ORG_A);
      expect(queue).toHaveLength(1);
      expect(queue[0].source_id).toBe(SOURCE_A);
      expect(queue[0].check_state).toBe('never_checked');
    } finally {
      activeClient = null;
      await client.end();
    }
  });

  test('a source checked after its last edit drops out of the queue', async () => {
    const client = await freshDatabase('ppbf_test_citationchecks_current');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await insertCheck(client);

      const queue = await getSourcesNeedingCitationCheck(ORG_A);
      expect(queue).toHaveLength(0);
    } finally {
      activeClient = null;
      await client.end();
    }
  });
});
