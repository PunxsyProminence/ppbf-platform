import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export function parseConnectionTarget(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('INVALID_POSTGRES_CONNECTION_STRING');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('INVALID_POSTGRES_PROTOCOL');
  }

  const hostname = parsed.hostname.toLowerCase();
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!hostname || !database) {
    throw new Error('INCOMPLETE_POSTGRES_TARGET');
  }

  return { hostname, database };
}

function assertExpectedTarget(target, expectedHostname, expectedDatabase) {
  if (
    target.hostname !== expectedHostname.toLowerCase()
    || target.database !== expectedDatabase
  ) {
    throw new Error('POSTGRES_TARGET_MISMATCH');
  }
}

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

/**
 * The reserved organization id. Duplicated as a literal here rather than
 * imported: this runner is a plain .mjs executed by node with no build step, and
 * platformLibraryScope.ts is TypeScript. platformLibraryScope.test.ts asserts
 * the TS constant, this literal and the migration SQL all agree, so the
 * duplication cannot drift silently.
 */
const PLATFORM_LIBRARY_ORGANIZATION_ID = '__platform__';

/**
 * Readiness asserts the migration's OUTCOMES, not that its statements ran.
 *
 * Four of these can fail independently while the SQL reports success:
 *
 *   - `library_organization_id` could exist and still be nullable if the
 *     backfill left a row behind, because `set not null` would have thrown --
 *     so the column's nullability is the real evidence the backfill covered
 *     every row.
 *   - The three replacement foreign keys are added inside a DO block guarded on
 *     `if not exists`. A guard that matched the wrong constraint name would skip
 *     the add and leave the citation path unprotected.
 *   - `stale_library_fkeys_remaining` is the one that matters most and the only
 *     one asserting an ABSENCE. The drop loop finds the originals by shape
 *     because Postgres auto-named them; if that shape query ever stops matching,
 *     the old organization_id-keyed foreign keys survive alongside the new ones
 *     and a gym citing a platform chunk still dies on an FK violation -- the
 *     exact failure this migration exists to remove, with every other check
 *     here green.
 *   - The reserved row itself is `on conflict do nothing`, so its presence
 *     proves nothing about this run; it is asserted because the rest of the
 *     migration is meaningless without it.
 */
const READINESS_QUERY = `
  select
    exists (
      select 1 from pilot.organizations
      where organization_id = $1
    ) as reserved_organization_present,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_evidence_items'
        and column_name = 'library_organization_id'
        and is_nullable = 'NO'
    ) as library_organization_column_ready,
    (
      select count(*) = 3 from pg_constraint
      where contype = 'c'
        and conname in (
          'pilot_accounts_not_platform_library_org',
          'pilot_org_memberships_not_platform_library_org',
          'pilot_athletes_not_platform_library_org'
        )
    ) as principal_guards_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_shadow_evidence_items_library_scope_check'
        and conrelid = to_regclass('pilot.shadow_evidence_items')
        and contype = 'c'
    ) as library_scope_check_ready,
    (
      select count(*) = 3 from pg_constraint
      where conrelid = to_regclass('pilot.shadow_evidence_items')
        and contype = 'f'
        and conname in (
          'pilot_shadow_evidence_items_source_library_fkey',
          'pilot_shadow_evidence_items_document_library_fkey',
          'pilot_shadow_evidence_items_chunk_library_fkey'
        )
    ) as library_foreign_keys_ready,
    (
      select count(*) = 0 from pg_constraint
      where conrelid = to_regclass('pilot.shadow_evidence_items')
        and contype = 'f'
        and confrelid in (
          to_regclass('pilot.shadow_library_sources'),
          to_regclass('pilot.shadow_library_documents'),
          to_regclass('pilot.shadow_library_chunks')
        )
        and pg_get_constraintdef(oid) not like '%library_organization_id%'
    ) as stale_library_fkeys_cleared,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and tablename = 'shadow_evidence_items'
        and indexname = 'idx_shadow_evidence_items_library_owner'
    ) as library_owner_index_ready
`;

function assertReadiness(row) {
  if (!row) {
    throw new Error('PLATFORM_LIBRARY_SCOPE_NOT_READY');
  }

  // Name the failing assertion. A bare error code sends the next operator back
  // into the SQL to guess which of seven outcomes did not land.
  const failed = Object.entries(row)
    .filter(([, value]) => value !== true)
    .map(([key]) => key);

  if (failed.length > 0) {
    throw new Error(`PLATFORM_LIBRARY_SCOPE_NOT_READY: ${failed.join(', ')}`);
  }
}

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY, [PLATFORM_LIBRARY_ORGANIZATION_ID]);
    assertReadiness(readiness.rows[0]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function run() {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  const expectedHostname = required('PPBF_EXPECTED_POSTGRES_HOSTNAME');
  const expectedDatabase = required('PPBF_EXPECTED_POSTGRES_DATABASE');

  const target = parseConnectionTarget(connectionString);
  assertExpectedTarget(target, expectedHostname, expectedDatabase);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const migrationPath = path.resolve(
    __dirname,
    '../../../infra/azure/pilot_slice_postgres_platform_library_scope_migration.sql',
  );

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  try {
    await applyMigrationTransaction(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied platform library scope migration: ${migrationPath}`);
  console.log('PILOT PLATFORM LIBRARY SCOPE MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT PLATFORM LIBRARY SCOPE MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
