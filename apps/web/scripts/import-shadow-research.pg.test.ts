// Real PostgreSQL-backed contract test for import-shadow-research.mjs
// running against a real transaction -- specifically the two guarantees
// that cannot be proven by the lightweight unit tests in
// import-shadow-research.test.ts, which never open a database connection:
//
// 1. assertReviewGateColumnsPresent (and therefore importSeedPackage)
//    fails loudly, with a clear message, when approval_state/
//    verification_state are absent from pilot.shadow_library_sources or
//    pilot.shadow_library_documents -- i.e. when
//    pilot_slice_postgres_shadow_evidence_migration.sql has not been
//    applied. It must not silently proceed and let the review gate not
//    exist.
// 2. Re-running importSeedPackage twice against the real seed package
//    produces IDENTICAL row counts across all five tables -- the new
//    approval_state/verification_state columns on the upsert's ON
//    CONFLICT clause do not turn a re-run into a duplicate-row bug.
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

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-import-shadow-research-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, 'test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../infra/azure');
const EVIDENCE_MIGRATION_FILE = 'pilot_slice_postgres_shadow_evidence_migration.sql';
const IMPORTER_PATH = path.resolve(__dirname, 'import-shadow-research.mjs');

const ORG_A = 'org-shadowresearch-a';
const OWNER_A = 'acct-shadowresearch-owner-a';

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let evidenceMigrationSql: string;
let importerModule: {
  loadSeedPackage: (input: {
    seedDir: string;
    organizationId: string;
    accountId: string;
    createdByRole?: string;
  }) => Promise<Record<string, unknown[]>>;
  importSeedPackage: (client: Client, seed: Record<string, unknown[]>, organizationId: string) => Promise<void>;
  assertReviewGateColumnsPresent: (client: Client) => Promise<void>;
  DEFAULT_SEED_DIR: string;
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

async function freshDatabase(name: string, { withEvidenceMigration }: { withEvidenceMigration: boolean }): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  if (withEvidenceMigration) {
    await client.query(evidenceMigrationSql);
  }

  await client.query(
    `insert into pilot.organizations (organization_id, organization_name, status)
     values ($1, $1, 'active') on conflict do nothing`,
    [ORG_A],
  );
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider, active_flag)
     values ($1, 'platform_owner', $2, 'microsoft', true) on conflict do nothing`,
    [OWNER_A, ORG_A],
  );

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

  baseSchemaSql = await fs.readFile(path.join(INFRA_DIR, 'pilot_slice_postgres.sql'), 'utf8');
  evidenceMigrationSql = await fs.readFile(path.join(INFRA_DIR, EVIDENCE_MIGRATION_FILE), 'utf8');

  importerModule = (await nativeDynamicImport(pathToFileURL(IMPORTER_PATH).href)) as typeof importerModule;
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

describe('assertReviewGateColumnsPresent / importSeedPackage prerequisite check', () => {
  test('fails loudly when the shadow-evidence migration has not been applied', async () => {
    const client = await freshDatabase('ppbf_test_shadowresearch_no_evidence_migration', {
      withEvidenceMigration: false,
    });
    try {
      const columns = await client.query(
        `select column_name from information_schema.columns
         where table_schema = 'pilot' and table_name = 'shadow_library_sources' and column_name = 'approval_state'`,
      );
      expect(columns.rowCount).toBe(0);

      await expect(importerModule.assertReviewGateColumnsPresent(client)).rejects.toThrow(
        /SHADOW_EVIDENCE_MIGRATION_NOT_APPLIED/,
      );

      const seed = await importerModule.loadSeedPackage({
        seedDir: importerModule.DEFAULT_SEED_DIR,
        organizationId: ORG_A,
        accountId: OWNER_A,
        createdByRole: 'platform_owner',
      });
      await expect(importerModule.importSeedPackage(client, seed, ORG_A)).rejects.toThrow(
        /SHADOW_EVIDENCE_MIGRATION_NOT_APPLIED/,
      );

      // Nothing was written -- the whole import is one transaction and the
      // prerequisite check runs before any upsert.
      const count = await client.query(`select count(*)::int as n from pilot.shadow_library_sources`);
      expect(count.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('succeeds once the shadow-evidence migration has been applied', async () => {
    const client = await freshDatabase('ppbf_test_shadowresearch_evidence_migration_ok', {
      withEvidenceMigration: true,
    });
    try {
      await expect(importerModule.assertReviewGateColumnsPresent(client)).resolves.toBeUndefined();
    } finally {
      await client.end();
    }
  });
});

describe('importSeedPackage idempotency against the real seed package', () => {
  test('re-running twice produces identical row counts across all five tables', async () => {
    const client = await freshDatabase('ppbf_test_shadowresearch_idempotent', { withEvidenceMigration: true });
    try {
      const seed = await importerModule.loadSeedPackage({
        seedDir: importerModule.DEFAULT_SEED_DIR,
        organizationId: ORG_A,
        accountId: OWNER_A,
        createdByRole: 'platform_owner',
      });

      await importerModule.importSeedPackage(client, seed, ORG_A);
      const firstCounts = await Promise.all([
        client.query(`select count(*)::int as n from pilot.shadow_library_sources where organization_id = $1`, [ORG_A]),
        client.query(`select count(*)::int as n from pilot.shadow_library_documents where organization_id = $1`, [ORG_A]),
        client.query(`select count(*)::int as n from pilot.shadow_library_chunks where organization_id = $1`, [ORG_A]),
        client.query(`select count(*)::int as n from pilot.shadow_library_capability_map where organization_id = $1`, [ORG_A]),
        client.query(`select count(*)::int as n from pilot.shadow_research_requirements where organization_id = $1`, [ORG_A]),
      ]);

      await importerModule.importSeedPackage(client, seed, ORG_A);
      const secondCounts = await Promise.all([
        client.query(`select count(*)::int as n from pilot.shadow_library_sources where organization_id = $1`, [ORG_A]),
        client.query(`select count(*)::int as n from pilot.shadow_library_documents where organization_id = $1`, [ORG_A]),
        client.query(`select count(*)::int as n from pilot.shadow_library_chunks where organization_id = $1`, [ORG_A]),
        client.query(`select count(*)::int as n from pilot.shadow_library_capability_map where organization_id = $1`, [ORG_A]),
        client.query(`select count(*)::int as n from pilot.shadow_research_requirements where organization_id = $1`, [ORG_A]),
      ]);

      expect(secondCounts.map((r) => r.rows[0].n)).toEqual(firstCounts.map((r) => r.rows[0].n));
      expect(firstCounts.map((r) => r.rows[0].n)).toEqual([1214, 14, 1193, 30, 229]);

      const reviewGate = await client.query(
        `select count(*)::int as n from pilot.shadow_library_sources
         where organization_id = $1 and (approval_state <> 'pending_review' or verification_state <> 'unverified')`,
        [ORG_A],
      );
      expect(reviewGate.rows[0].n).toBe(0);

      const ingestState = await client.query(
        `select count(*)::int as n from pilot.shadow_library_documents
         where organization_id = $1 and ingest_state <> 'pending'`,
        [ORG_A],
      );
      expect(ingestState.rows[0].n).toBe(0);
    } finally {
      await client.end();
    }
  });
});
