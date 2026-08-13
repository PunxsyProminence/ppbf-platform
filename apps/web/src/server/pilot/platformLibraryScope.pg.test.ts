// Real PostgreSQL contract test for the platform-library-scope migration.
//
// platformLibraryScope.test.ts already binds the reserved id across the TS
// module, the migration SQL and the runner -- but every one of those assertions
// is a string match on a file. That direction cannot reach the failures this
// migration is actually exposed to, all of which are behaviours of a live
// database:
//
//   - The stale library foreign keys are dropped BY SHAPE, because Postgres
//     auto-named the originals. A regex over the SQL proves the loop was
//     written, never that it matches a real pg_constraint row. If it stops
//     matching, the organization_id-keyed keys survive beside the new ones and a
//     gym citing a platform chunk still dies on an FK violation -- the exact
//     failure this migration exists to remove.
//   - `set not null` only succeeds if the backfill reached every pre-existing
//     row, so the column's nullability is evidence about rows, not about text.
//   - A CHECK can be present and still not forbid what its comment claims.
//   - The migration is in the `all` rebuild loop, so a re-run must be a no-op.
//
// So this suite executes the migration and then tries to break the rules,
// including the one case that must SUCCEED: a gym citing the baseline. Each
// refusal is paired with a control that the same insert works where it is
// supposed to, or the suite would pass just as happily against malformed SQL.
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

import { PLATFORM_LIBRARY_ORGANIZATION_ID } from './platformLibraryScope';

jest.setTimeout(180_000);

const PG_USER = 'postgres';
const PG_PASSWORD = 'postgres';
const DATA_DIR = path.join(os.tmpdir(), `ppbf-platform-library-scope-pg-test-${Date.now()}`);
const SERVER_SCRIPT_PATH = path.resolve(__dirname, '../../../scripts/test-embedded-pg-server.mjs');
const INFRA_DIR = path.resolve(__dirname, '../../../../../infra/azure');

const GYM = 'org-gym-one';
const OTHER_GYM = 'org-gym-two';
const PLATFORM = PLATFORM_LIBRARY_ORGANIZATION_ID;

const COACH = 'acct-coach-one';
const ATHLETE = 'ATH-ONE';

const SHA = 'a'.repeat(64);
const BUNDLE_ID = '11111111-1111-4111-8111-111111111111';

let PG_PORT: number;
let serverProcess: ChildProcessByStdio<null, Readable, Readable>;
let baseSchemaSql: string;
let evidenceMigrationSql: string;
let platformMigrationSql: string;

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
 * A database with the library and evidence tables and two real gyms.
 *
 * `applyPlatformMigration` is optional on purpose: the pre-migration state is
 * what proves the migration fixes a real failure rather than a hypothetical one.
 */
async function freshDatabase(
  name: string,
  { applyPlatformMigration = true, seedEvidenceItemFirst = false } = {},
): Promise<Client> {
  const admin = new Client({ connectionString: connectionStringFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${name}`);
  await admin.query(`create database ${name}`);
  await admin.end();

  const client = new Client({ connectionString: connectionStringFor(name) });
  await client.connect();
  await client.query(baseSchemaSql);
  await client.query(evidenceMigrationSql);

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
    // A row that exists BEFORE the column does. `set not null` can only succeed
    // if the backfill reached it, so this is what makes the nullability
    // assertion evidence about data rather than about DDL.
    await seedLibraryRow(client, GYM, 'pre');
    await seedBundle(client, GYM);
    await client.query(
      `insert into pilot.shadow_evidence_items
         (evidence_id, bundle_id, organization_id, account_id, source_id, document_id, chunk_id, ordinal, excerpt_sha256)
       values (gen_random_uuid(), $1, $2, $3, 'src-pre', 'doc-pre', 'chunk-pre', 1, $4)`,
      [BUNDLE_ID, GYM, COACH, SHA],
    );
  }

  if (applyPlatformMigration) {
    await client.query(platformMigrationSql);
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

/**
 * Run one statement in its own transaction and always roll it back, so a probe
 * that unexpectedly succeeds still leaves no row behind for the next assertion.
 * Returns the constraint name Postgres blamed, or null when the insert was
 * accepted.
 */
async function attempt(client: Client, sql: string, params: unknown[] = []): Promise<string | null> {
  await client.query('BEGIN');
  try {
    await client.query(sql, params);
    await client.query('ROLLBACK');
    return null;
  } catch (error) {
    await client.query('ROLLBACK');
    const { constraint, code, message } = error as { constraint?: string; code?: string; message?: string };
    return constraint ?? code ?? message ?? 'unknown';
  }
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
  evidenceMigrationSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_shadow_evidence_migration.sql'),
    'utf8',
  );
  platformMigrationSql = await fs.readFile(
    path.join(INFRA_DIR, 'pilot_slice_postgres_platform_library_scope_migration.sql'),
    'utf8',
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
});

describe('the migration applies, and applying it twice is a no-op', () => {
  test('a re-run changes nothing -- it is in the `all` rebuild loop', async () => {
    const client = await freshDatabase('ppbf_pls_idempotent');
    try {
      await client.query(platformMigrationSql);
      await client.query(platformMigrationSql);

      const org = await client.query(
        'select organization_name from pilot.organizations where organization_id = $1',
        [PLATFORM],
      );
      expect(org.rows).toEqual([{ organization_name: 'PPBF Platform Evidence Baseline' }]);
    } finally {
      await client.end();
    }
  });

  test('the reserved organization is present after apply', async () => {
    const client = await freshDatabase('ppbf_pls_reserved');
    try {
      const org = await client.query('select status from pilot.organizations where organization_id = $1', [PLATFORM]);
      expect(org.rows).toEqual([{ status: 'active' }]);
    } finally {
      await client.end();
    }
  });
});

describe('library_organization_id', () => {
  // The backfill case. A pre-existing row is inserted before the column exists,
  // so `set not null` succeeding is evidence the update reached it.
  test('a row written before the migration is backfilled to its own organization', async () => {
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

  test('no organization_id-keyed library foreign key survives the drop-by-shape loop', async () => {
    const client = await freshDatabase('ppbf_pls_fk_swap');
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

      const replacements = await client.query(`
        select conname from pg_constraint
        where conrelid = to_regclass('pilot.shadow_evidence_items') and contype = 'f'
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
});

describe('a gym may cite the baseline, and nothing else', () => {
  // The whole point of the migration, and the assertion that would have caught
  // the FK overload before it reached a live database.
  test('an evidence item in a gym cites a platform chunk successfully', async () => {
    const client = await freshDatabase('ppbf_pls_cite_platform');
    try {
      const platformRow = await seedLibraryRow(client, PLATFORM, 'plat');
      await seedBundle(client, GYM);

      const failure = await attempt(
        client,
        `insert into pilot.shadow_evidence_items
           (evidence_id, bundle_id, organization_id, account_id, source_id, document_id, chunk_id,
            ordinal, excerpt_sha256, library_organization_id)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 2, $7, $8)`,
        [BUNDLE_ID, GYM, COACH, platformRow.sourceId, platformRow.documentId, platformRow.chunkId, SHA, PLATFORM],
      );

      expect(failure).toBeNull();
    } finally {
      await client.end();
    }
  });

  // Before the migration the same insert is impossible. This is what makes the
  // test above a fix rather than a coincidence.
  test('without the migration, that same citation is refused', async () => {
    const client = await freshDatabase('ppbf_pls_pre_migration', { applyPlatformMigration: false });
    try {
      await client.query(
        `insert into pilot.organizations (organization_id, organization_name, status)
         values ($1, 'Baseline', 'active') on conflict do nothing`,
        [PLATFORM],
      );
      const platformRow = await seedLibraryRow(client, PLATFORM, 'plat');
      await seedBundle(client, GYM);

      const failure = await attempt(
        client,
        `insert into pilot.shadow_evidence_items
           (evidence_id, bundle_id, organization_id, account_id, source_id, document_id, chunk_id,
            ordinal, excerpt_sha256)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 2, $7)`,
        [BUNDLE_ID, GYM, COACH, platformRow.sourceId, platformRow.documentId, platformRow.chunkId, SHA],
      );

      expect(failure).not.toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a gym citing a THIRD gym is refused by the scope check', async () => {
    const client = await freshDatabase('ppbf_pls_cite_other_gym');
    try {
      const otherRow = await seedLibraryRow(client, OTHER_GYM, 'other');
      await seedBundle(client, GYM);

      const failure = await attempt(
        client,
        `insert into pilot.shadow_evidence_items
           (evidence_id, bundle_id, organization_id, account_id, source_id, document_id, chunk_id,
            ordinal, excerpt_sha256, library_organization_id)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 2, $7, $8)`,
        [BUNDLE_ID, GYM, COACH, otherRow.sourceId, otherRow.documentId, otherRow.chunkId, SHA, OTHER_GYM],
      );

      expect(failure).toBe('pilot_shadow_evidence_items_library_scope_check');
    } finally {
      await client.end();
    }
  });

  test('a gym citing its own shelf still works', async () => {
    const client = await freshDatabase('ppbf_pls_cite_own');
    try {
      const own = await seedLibraryRow(client, GYM, 'own');
      await seedBundle(client, GYM);

      const failure = await attempt(
        client,
        `insert into pilot.shadow_evidence_items
           (evidence_id, bundle_id, organization_id, account_id, source_id, document_id, chunk_id,
            ordinal, excerpt_sha256, library_organization_id)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 2, $7, $8)`,
        [BUNDLE_ID, GYM, COACH, own.sourceId, own.documentId, own.chunkId, SHA, GYM],
      );

      expect(failure).toBeNull();
    } finally {
      await client.end();
    }
  });
});

describe('nobody lives in the reserved organization', () => {
  test.each([
    ['accounts', 'pilot_accounts_not_platform_library_org'],
    ['organization_memberships', 'pilot_org_memberships_not_platform_library_org'],
    ['athletes', 'pilot_athletes_not_platform_library_org'],
  ])('%s refuses the reserved organization', async (table, constraint) => {
    const client = await freshDatabase(`ppbf_pls_principal_${table}`);
    try {
      const statements: Record<string, string> = {
        // Every statement here must consume BOTH parameters: pg rejects a bind
        // with more parameters than the statement uses (08P01), and that error
        // would masquerade as the guard firing if this suite only asserted
        // "it threw" instead of naming the constraint.
        accounts: `insert into pilot.accounts (account_id, role, organization_id, auth_provider)
                   values ($2 || '-probe', 'coach', $1, 'microsoft')`,
        organization_memberships: `insert into pilot.organization_memberships (account_id, organization_id, role)
                                   values ($2, $1, 'coach')`,
        athletes: `insert into pilot.athletes (organization_id, athlete_id, full_name, dob, weight_class,
                     gym_status, emergency_contact, active_flag, coach_id, created_at, updated_at)
                   values ($1, 'ATH-PROBE', 'Probe', '2011-01-01', 'fly', 'active', 'c', true, $2, now(), now())`,
      };

      const refusal = await attempt(client, statements[table], [PLATFORM, COACH]);
      expect(refusal).toBe(constraint);

      // Control: the identical insert into a real gym is accepted, so the
      // refusal above is the CHECK and not a malformed statement.
      const control = await attempt(client, statements[table], [GYM, COACH]);
      expect(control).toBeNull();
    } finally {
      await client.end();
    }
  });
});

describe('a baseline row can never be about one athlete', () => {
  // subject_id carries no foreign key, so a platform row seeded with a real
  // athlete's id would be accepted and searchShadowLibrary's subject branch
  // would surface baseline material as a finding about that child. Section 2
  // cannot stop this one: an operator writes it, not a principal.
  test.each([
    ['shadow_library_documents', 'pilot_shadow_library_documents_platform_unscoped_check'],
    ['shadow_library_chunks', 'pilot_shadow_library_chunks_platform_unscoped_check'],
  ])('%s refuses a subject-scoped platform row', async (table, constraint) => {
    const client = await freshDatabase(`ppbf_pls_subject_${table}`);
    try {
      await seedLibraryRow(client, PLATFORM, 'base');

      const statements: Record<string, string> = {
        shadow_library_documents: `insert into pilot.shadow_library_documents
            (document_id, source_id, organization_id, document_name, content_sha256, subject_id)
          values ('doc-probe', 'src-base', $1, 'Probe', 'probe-sha', $2)`,
        shadow_library_chunks: `insert into pilot.shadow_library_chunks
            (chunk_id, document_id, source_id, organization_id, ordinal, text_content, subject_id)
          values ('chunk-probe', 'doc-base', 'src-base', $1, 9, 'Body', $2)`,
      };

      const refusal = await attempt(client, statements[table], [PLATFORM, ATHLETE]);
      expect(refusal).toBe(constraint);

      // Two controls, because one is not enough to locate the rule: the same
      // row with no subject is fine on the baseline, and a subject-scoped row
      // is fine on a gym's own shelf. The CHECK is about the pair, not either
      // column alone.
      const unscopedOnPlatform = await attempt(client, statements[table], [PLATFORM, null]);
      expect(unscopedOnPlatform).toBeNull();
    } finally {
      await client.end();
    }
  });

  test('a gym may still scope its own library row to one of its athletes', async () => {
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
