// Real PostgreSQL regression coverage for the platform-library-scope migration.
//
// platformLibraryScope.test.ts already binds the reserved id across the TS
// module, the migration SQL and the runner -- and every assertion there is a
// string match on a file. That direction cannot reach the failures this
// migration is exposed to, because all of them are behaviours of a live
// database:
//
//   - The stale library foreign keys are dropped BY SHAPE, because Postgres
//     auto-named the originals. A regex proves the loop was written, never that
//     it matches a real pg_constraint row. If it stops matching, the
//     organization_id-keyed keys survive beside the new ones and a gym citing a
//     platform chunk still dies on a foreign key violation -- the exact failure
//     this migration exists to remove.
//   - `set not null` only succeeds if the backfill reached every pre-existing
//     row, so the column's nullability is evidence about rows, not about DDL.
//   - A CHECK can be present and still not forbid what its comment claims.
//
// So this suite drives the real runner's exported applyMigrationTransaction and
// then tries to break the rules, including the two cases that must SUCCEED: a
// gym citing its own shelf, and a gym citing the baseline. Every refusal is
// paired with a control proving the same insert works where it is supposed to,
// so a malformed fixture statement cannot produce a false-positive guard.
//
// Spins up the same disposable, local-only embedded Postgres the other
// migration suites use. It NEVER reads AZURE_POSTGRES_CONNECTION_STRING and
// never connects to staging or production -- run() is deliberately not called;
// only applyMigrationTransaction, which takes a client this suite owns.

import { type ChildProcessByStdio, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { Client } from 'pg';

import { PLATFORM_LIBRARY_ORGANIZATION_ID } from './platformLibraryScope';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-platform-library-scope-pg-test-${process.pid}-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');
const MIGRATION_FILE = 'pilot_slice_postgres_platform_library_scope_migration.sql';
const MIGRATION_RUNNER_PATH = path.resolve(
  __dirname,
  '../../../scripts/pilot-apply-platform-library-scope-migration.mjs',
);

// The minimum prerequisite set, and no more. The base schema creates
// organizations, accounts, organization_memberships, athletes and the three
// library tables; the shadow-evidence migration creates the bundles and
// evidence-item tables this migration alters. Nothing else is needed to
// exercise the tenancy rules under test.
const PREREQUISITE_FILES = [
  'pilot_slice_postgres.sql',
  'pilot_slice_postgres_shadow_evidence_migration.sql',
];

const nativeDynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<Record<string, unknown>>;

const GYM = 'org-gym-one';
const OTHER_GYM = 'org-gym-two';
const PLATFORM = PLATFORM_LIBRARY_ORGANIZATION_ID;

const COACH = 'acct-coach-one';
const ATHLETE = 'ATH-ONE';

const SHA = 'a'.repeat(64);
const BUNDLE_ID = '11111111-1111-4111-8111-111111111111';

/** Postgres SQLSTATE for a violated CHECK constraint. */
const CHECK_VIOLATION = '23514';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let prerequisiteSchemaSql: string[];
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

/**
 * A database carrying the prerequisite schema and two real gyms.
 *
 * `applyPlatformMigration` is optional because the un-migrated state is itself
 * under test twice: once for the runner's readiness gate, and once to show the
 * cross-tenant citation really was impossible before.
 */
async function freshDatabase(
  name: string,
  { applyPlatformMigration = true, seedEvidenceItemFirst = false } = {},
): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name} encoding 'UTF8' template template0`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  for (const sql of prerequisiteSchemaSql) {
    await client.query(sql);
  }

  for (const organizationId of [GYM, OTHER_GYM]) {
    await client.query(
      `insert into pilot.organizations (organization_id, organization_name, status)
       values ($1, $1, 'active') on conflict do nothing`,
      [organizationId],
    );
  }
  await client.query(
    `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
     values ($1, 'coach', $2, 'microsoft') on conflict do nothing`,
    [COACH, GYM],
  );
  await client.query(
    `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
       gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
     values ($1, $2, 'Gym Athlete', '2011-04-05', 'fly', 'active', 'contact', true, $3, now(), now())
     on conflict do nothing`,
    [GYM, ATHLETE, COACH],
  );

  if (seedEvidenceItemFirst) {
    // Written BEFORE the column exists. `alter column ... set not null` can only
    // succeed if the backfill reached this row, which is what makes the
    // nullability assertion evidence about data rather than about DDL.
    await seedLibraryRow(client, GYM, 'pre');
    await seedBundle(client, GYM);
    await client.query(
      `insert into pilot.shadow_evidence_items
         (evidence_id, bundle_id, organization_id, account_id, source_id, document_id, chunk_id,
          ordinal, excerpt_sha256)
       values (gen_random_uuid(), $1, $2, $3, 'src-pre', 'doc-pre', 'chunk-pre', 1, $4)`,
      [BUNDLE_ID, GYM, COACH, SHA],
    );
  }

  if (applyPlatformMigration) {
    await applyMigrationTransaction(client, migrationSql);
  }

  return client;
}

/** A source, document and chunk owned by `organizationId`, suffixed by `tag`. */
async function seedLibraryRow(
  client: Client,
  organizationId: string,
  tag: string,
  { subjectId = null as string | null } = {},
): Promise<{ sourceId: string; documentId: string; chunkId: string }> {
  const sourceId = `src-${tag}`;
  const documentId = `doc-${tag}`;
  const chunkId = `chunk-${tag}`;

  await client.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, source_type, authority_tier, url)
     values ($1, $2, $3, 'peer_reviewed', 1, $4)`,
    [sourceId, organizationId, `Title ${tag}`, `https://example.org/${tag}`],
  );
  await client.query(
    `insert into pilot.shadow_library_documents
       (document_id, source_id, organization_id, document_name, content_sha256, subject_id)
     values ($1, $2, $3, $4, $5, $6)`,
    [documentId, sourceId, organizationId, `Document ${tag}`, `${tag}-sha`, subjectId],
  );
  await client.query(
    `insert into pilot.shadow_library_chunks
       (chunk_id, document_id, source_id, organization_id, ordinal, text_content, subject_id)
     values ($1, $2, $3, $4, 1, $5, $6)`,
    [chunkId, documentId, sourceId, organizationId, `Body ${tag}`, subjectId],
  );

  return { sourceId, documentId, chunkId };
}

async function seedBundle(client: Client, organizationId: string): Promise<void> {
  await client.query(
    `insert into pilot.shadow_evidence_bundles
       (bundle_id, organization_id, account_id, query_sha256, availability, item_count)
     values ($1, $2, $3, $4, 'available', 1)
     on conflict do nothing`,
    [BUNDLE_ID, organizationId, COACH, SHA],
  );
}

interface AttemptResult {
  ok: boolean;
  constraint: string | null;
  code: string | null;
}

/**
 * Run one statement in its own transaction and always roll it back, so a probe
 * that unexpectedly SUCCEEDS leaves no row behind for the next assertion.
 *
 * Returns the constraint and SQLSTATE Postgres blamed. Negative cases assert on
 * those rather than on "it threw": a malformed fixture statement also throws,
 * and would otherwise read as the guard working.
 */
async function attempt(client: Client, sql: string, params: unknown[] = []): Promise<AttemptResult> {
  await client.query('BEGIN');
  try {
    await client.query(sql, params);
    await client.query('ROLLBACK');
    return { ok: true, constraint: null, code: null };
  } catch (error) {
    await client.query('ROLLBACK');
    const { constraint, code } = error as { constraint?: string; code?: string };
    return { ok: false, constraint: constraint ?? null, code: code ?? null };
  }
}

const CITE_SQL = `insert into pilot.shadow_evidence_items
    (evidence_id, bundle_id, organization_id, account_id, source_id, document_id, chunk_id,
     ordinal, excerpt_sha256, library_organization_id)
  values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 2, $7, $8)`;

function citeParams(
  itemOrganizationId: string,
  cited: { sourceId: string; documentId: string; chunkId: string },
  libraryOrganizationId: string,
): unknown[] {
  return [
    BUNDLE_ID,
    itemOrganizationId,
    COACH,
    cited.sourceId,
    cited.documentId,
    cited.chunkId,
    SHA,
    libraryOrganizationId,
  ];
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

  prerequisiteSchemaSql = await Promise.all(
    PREREQUISITE_FILES.map((file) => fs.readFile(path.join(INFRA_DIR, file), 'utf8')),
  );
  migrationSql = await fs.readFile(path.join(INFRA_DIR, MIGRATION_FILE), 'utf8');

  const runnerModule = await nativeDynamicImport(pathToFileURL(MIGRATION_RUNNER_PATH).href);
  applyMigrationTransaction = runnerModule.applyMigrationTransaction as (
    c: Client,
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
  // Only this suite's own directory, named for this process. Other leaked
  // directories belong to other runs and are not this suite's to remove.
  await fs.rm(DATA_DIR, { recursive: true, force: true });
});

describe('the runner gates on outcomes, not on having executed', () => {
  test('an otherwise valid schema is refused while the migration has not run', async () => {
    const client = await freshDatabase('ppbf_pls_not_applied', { applyPlatformMigration: false });
    try {
      // A no-op statement: the runner opens its transaction, applies nothing,
      // and its readiness query must still refuse. This is the assertion that
      // the gate checks the database rather than the fact that SQL ran.
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /PLATFORM_LIBRARY_SCOPE_NOT_READY/,
      );

      // And it rolled back rather than leaving a half-applied database behind.
      const reserved = await client.query(
        'select 1 from pilot.organizations where organization_id = $1',
        [PLATFORM],
      );
      expect(reserved.rowCount).toBe(0);
    } finally {
      await client.end();
    }
  });

  test('the refusal names which outcomes are missing', async () => {
    const client = await freshDatabase('ppbf_pls_named_failures', { applyPlatformMigration: false });
    try {
      await expect(applyMigrationTransaction(client, 'select 1')).rejects.toThrow(
        /platform_organization_ready/,
      );
    } finally {
      await client.end();
    }
  });
});

describe('applying the migration', () => {
  test('creates the reserved organization, active', async () => {
    const client = await freshDatabase('ppbf_pls_reserved');
    try {
      const org = await client.query(
        'select organization_name, status from pilot.organizations where organization_id = $1',
        [PLATFORM],
      );
      expect(org.rows).toEqual([{ organization_name: 'PPBF Platform Evidence Baseline', status: 'active' }]);
    } finally {
      await client.end();
    }
  });

  test('is idempotent -- it sits in the `all` rebuild loop', async () => {
    const client = await freshDatabase('ppbf_pls_idempotent');
    try {
      await applyMigrationTransaction(client, migrationSql);
      await applyMigrationTransaction(client, migrationSql);

      const org = await client.query(
        'select count(*)::int as n from pilot.organizations where organization_id = $1',
        [PLATFORM],
      );
      expect(org.rows[0].n).toBe(1);
    } finally {
      await client.end();
    }
  });
});

describe('library_organization_id', () => {
  test('a row written before the migration is backfilled to its own organization, and the column is NOT NULL', async () => {
    const client = await freshDatabase('ppbf_pls_backfill', { seedEvidenceItemFirst: true });
    try {
      const rows = await client.query(
        'select organization_id, library_organization_id from pilot.shadow_evidence_items',
      );
      expect(rows.rows).toEqual([{ organization_id: GYM, library_organization_id: GYM }]);

      const column = await client.query(`
        select is_nullable from information_schema.columns
        where table_schema = 'pilot' and table_name = 'shadow_evidence_items'
          and column_name = 'library_organization_id'`);
      expect(column.rows[0].is_nullable).toBe('NO');
    } finally {
      await client.end();
    }
  });

  test('no library foreign key keyed only by organization_id survives the drop-by-shape loop', async () => {
    const client = await freshDatabase('ppbf_pls_fk_stale');
    try {
      const stale = await client.query(`
        select conname from pg_constraint
        where conrelid = to_regclass('pilot.shadow_evidence_items')
          and contype = 'f'
          and confrelid in (
            to_regclass('pilot.shadow_library_sources'),
            to_regclass('pilot.shadow_library_documents'),
            to_regclass('pilot.shadow_library_chunks'))
          and pg_get_constraintdef(oid) not like '%library_organization_id%'`);
      expect(stale.rows).toEqual([]);
    } finally {
      await client.end();
    }
  });

  test('exactly the three intended library foreign keys use library_organization_id', async () => {
    const client = await freshDatabase('ppbf_pls_fk_replacements');
    try {
      const replacements = await client.query(`
        select conname from pg_constraint
        where conrelid = to_regclass('pilot.shadow_evidence_items')
          and contype = 'f'
          and pg_get_constraintdef(oid) like '%library_organization_id%'
        order by conname`);
      expect(replacements.rows.map((r) => r.conname)).toEqual([
        'pilot_shadow_evidence_items_chunk_library_fkey',
        'pilot_shadow_evidence_items_document_library_fkey',
        'pilot_shadow_evidence_items_source_library_fkey',
      ]);
    } finally {
      await client.end();
    }
  });

  // Splitting the two meanings apart is only safe while the bundle half stays
  // pinned to the asking gym. If that key drifted onto library_organization_id,
  // one gym's item could attach to another gym's bundle.
  test('the bundle foreign key is still scoped to the requesting gym', async () => {
    const client = await freshDatabase('ppbf_pls_bundle_fk');
    try {
      const bundleKeys = await client.query(`
        select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = to_regclass('pilot.shadow_evidence_items')
          and contype = 'f'
          and confrelid = to_regclass('pilot.shadow_evidence_bundles')`);
      expect(bundleKeys.rows).toHaveLength(1);
      expect(bundleKeys.rows[0].def).toContain('(bundle_id, organization_id, account_id)');
      expect(bundleKeys.rows[0].def).not.toContain('library_organization_id');
    } finally {
      await client.end();
    }
  });
});

describe('a gym may cite its own shelf and the baseline, and nothing else', () => {
  test('a gym cites its own library row', async () => {
    const client = await freshDatabase('ppbf_pls_cite_own');
    try {
      const own = await seedLibraryRow(client, GYM, 'own');
      await seedBundle(client, GYM);

      const result = await attempt(client, CITE_SQL, citeParams(GYM, own, GYM));
      expect(result).toEqual({ ok: true, constraint: null, code: null });
    } finally {
      await client.end();
    }
  });

  // The whole point of the migration.
  test('a gym cites a platform source, document and chunk', async () => {
    const client = await freshDatabase('ppbf_pls_cite_platform');
    try {
      const platformRow = await seedLibraryRow(client, PLATFORM, 'plat');
      await seedBundle(client, GYM);

      const result = await attempt(client, CITE_SQL, citeParams(GYM, platformRow, PLATFORM));
      expect(result).toEqual({ ok: true, constraint: null, code: null });
    } finally {
      await client.end();
    }
  });

  // Without the migration the same citation is impossible, which is what makes
  // the test above a fix rather than a coincidence.
  test('before the migration, citing a platform row is refused', async () => {
    const client = await freshDatabase('ppbf_pls_cite_pre_migration', { applyPlatformMigration: false });
    try {
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ($1, 'Baseline', 'active') on conflict do nothing`,
        [PLATFORM],
      );
      const platformRow = await seedLibraryRow(client, PLATFORM, 'plat');
      await seedBundle(client, GYM);

      const result = await attempt(
        client,
        `insert into pilot.shadow_evidence_items
           (evidence_id, bundle_id, organization_id, account_id, source_id, document_id, chunk_id,
            ordinal, excerpt_sha256)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 2, $7)`,
        [BUNDLE_ID, GYM, COACH, platformRow.sourceId, platformRow.documentId, platformRow.chunkId, SHA],
      );

      expect(result.ok).toBe(false);
      // 23503 = foreign_key_violation: the pre-split keys force
      // organization_id to be the owner of the cited row.
      expect(result.code).toBe('23503');
    } finally {
      await client.end();
    }
  });

  test('a gym citing another gym is refused by the named scope check', async () => {
    const client = await freshDatabase('ppbf_pls_cite_other_gym');
    try {
      const otherRow = await seedLibraryRow(client, OTHER_GYM, 'other');
      await seedBundle(client, GYM);

      const result = await attempt(client, CITE_SQL, citeParams(GYM, otherRow, OTHER_GYM));

      expect(result.ok).toBe(false);
      expect(result.constraint).toBe('pilot_shadow_evidence_items_library_scope_check');
      expect(result.code).toBe(CHECK_VIOLATION);
    } finally {
      await client.end();
    }
  });
});

describe('nobody lives in the reserved organization', () => {
  const PRINCIPAL_STATEMENTS: Record<string, string> = {
    // Every statement consumes BOTH parameters. pg rejects a bind carrying more
    // parameters than the statement uses (08P01), and that error would
    // masquerade as the guard firing if these cases asserted only "it threw".
    accounts: `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
               values ($2 || '-probe', 'coach', $1, 'microsoft')`,
    organization_memberships: `insert into pilot.organization_memberships (account_id, organization_id, role)
                               values ($2, $1, 'coach')`,
    athletes: `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
                 gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
               values ($1, 'ATH-PROBE', 'Probe', '2011-01-01', 'fly', 'active', 'c', true, $2, now(), now())`,
  };

  test.each([
    ['accounts', 'pilot_accounts_not_platform_library_org'],
    ['organization_memberships', 'pilot_org_memberships_not_platform_library_org'],
    ['athletes', 'pilot_athletes_not_platform_library_org'],
  ])('%s refuses the reserved organization, and admits a real gym', async (table, constraint) => {
    const client = await freshDatabase(`ppbf_pls_principal_${table}`);
    try {
      const refused = await attempt(client, PRINCIPAL_STATEMENTS[table], [PLATFORM, COACH]);
      expect(refused.ok).toBe(false);
      expect(refused.constraint).toBe(constraint);
      expect(refused.code).toBe(CHECK_VIOLATION);

      const control = await attempt(client, PRINCIPAL_STATEMENTS[table], [GYM, COACH]);
      expect(control).toEqual({ ok: true, constraint: null, code: null });
    } finally {
      await client.end();
    }
  });
});

describe('a baseline row can never be about one athlete', () => {
  // subject_id carries no foreign key on either table, so a platform row seeded
  // with a real athlete's id would be accepted and searchShadowLibrary's subject
  // branch would surface baseline material as a finding about that child. The
  // principal guards cannot stop this one: an operator writes it, not a
  // principal.
  const SUBJECT_STATEMENTS: Record<string, string> = {
    shadow_library_documents: `insert into pilot.shadow_library_documents
        (document_id, source_id, organization_id, document_name, content_sha256, subject_id)
      values ('doc-probe', 'src-base', $1, 'Probe', 'probe-sha', $2)`,
    shadow_library_chunks: `insert into pilot.shadow_library_chunks
        (chunk_id, document_id, source_id, organization_id, ordinal, text_content, subject_id)
      values ('chunk-probe', 'doc-base', 'src-base', $1, 9, 'Body', $2)`,
  };

  test.each([
    ['shadow_library_documents', 'pilot_shadow_library_documents_platform_unscoped_check'],
    ['shadow_library_chunks', 'pilot_shadow_library_chunks_platform_unscoped_check'],
  ])('%s refuses a subject-scoped platform row, and admits an unscoped one', async (table, constraint) => {
    const client = await freshDatabase(`ppbf_pls_subject_${table}`);
    try {
      await seedLibraryRow(client, PLATFORM, 'base');

      const refused = await attempt(client, SUBJECT_STATEMENTS[table], [PLATFORM, ATHLETE]);
      expect(refused.ok).toBe(false);
      expect(refused.constraint).toBe(constraint);
      expect(refused.code).toBe(CHECK_VIOLATION);

      // Control: the same row with no subject is fine on the baseline, so the
      // CHECK is about the pair and not about subject_id alone.
      const control = await attempt(client, SUBJECT_STATEMENTS[table], [PLATFORM, null]);
      expect(control).toEqual({ ok: true, constraint: null, code: null });
    } finally {
      await client.end();
    }
  });

  // The other half of the pair: a gym may still scope its own library row to one
  // of its athletes, which is what subject_id is for.
  test('a gym may still subject-scope its own library row', async () => {
    const client = await freshDatabase('ppbf_pls_subject_gym_ok');
    try {
      const seeded = await seedLibraryRow(client, GYM, 'gymsub', { subjectId: ATHLETE });

      const rows = await client.query(
        'select subject_id from pilot.shadow_library_chunks where chunk_id = $1',
        [seeded.chunkId],
      );
      expect(rows.rows).toEqual([{ subject_id: ATHLETE }]);
    } finally {
      await client.end();
    }
  });
});
