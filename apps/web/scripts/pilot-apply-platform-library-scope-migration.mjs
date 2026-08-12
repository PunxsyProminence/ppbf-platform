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

// Same reasoning as db.ts's resolveSslConfig and the other pilot-apply-*
// scripts: production/staging always require TLS.
function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

// Kept in lockstep with PLATFORM_LIBRARY_ORGANIZATION_ID in
// src/server/pilot/platformLibraryScope.ts. platformLibraryScope.test.ts reads
// the migration SQL and asserts the two agree, so a change in one place fails
// the suite rather than silently splitting the corpus in half.
const PLATFORM_ORGANIZATION_ID = '__platform__';

// Asserts what this migration is FOR, not that it ran. The two failure modes
// worth catching are opposites of each other:
//
//   * the reserved organization missing, or its guards missing -- the corpus
//     has no home, or worse, has a home a gym's principal can write to;
//   * shadow_evidence_items still keying its library foreign keys on
//     organization_id -- retrieval would find platform chunks and the bundle
//     insert would then die on a foreign key violation, which surfaces to a
//     user as SHADOW failing mid-answer rather than as an unapplied migration.
//
// `library_scope_exclusive_ready` asserts an ABSENCE deliberately: any surviving
// foreign key from this table into a library table that does NOT mention
// library_organization_id is one of the originals, and it would re-impose the
// equality this migration exists to relax.
//
// to_regclass() rather than the ::regclass cast throughout: the cast raises
// before any column is evaluated when a table is absent, which would report an
// unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    exists (
      select 1 from pilot.organizations
      where organization_id = '${PLATFORM_ORGANIZATION_ID}'
        and status = 'active'
    ) as platform_organization_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_accounts_not_platform_library_org'
        and conrelid = to_regclass('pilot.accounts')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%${PLATFORM_ORGANIZATION_ID}%'
    ) as accounts_guard_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_org_memberships_not_platform_library_org'
        and conrelid = to_regclass('pilot.organization_memberships')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%${PLATFORM_ORGANIZATION_ID}%'
    ) as memberships_guard_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_athletes_not_platform_library_org'
        and conrelid = to_regclass('pilot.athletes')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%${PLATFORM_ORGANIZATION_ID}%'
    ) as athletes_guard_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_evidence_items'
        and column_name = 'library_organization_id'
        and is_nullable = 'NO'
    ) as library_owner_column_ready,
    (
      select count(*) = 3
      from pg_constraint
      where conrelid = to_regclass('pilot.shadow_evidence_items')
        and contype = 'f'
        and confrelid in (
          to_regclass('pilot.shadow_library_sources'),
          to_regclass('pilot.shadow_library_documents'),
          to_regclass('pilot.shadow_library_chunks')
        )
        and pg_get_constraintdef(oid) like '%library_organization_id%'
    ) as library_foreign_keys_ready,
    (
      to_regclass('pilot.shadow_evidence_items') is not null
      and not exists (
        select 1 from pg_constraint
        where conrelid = to_regclass('pilot.shadow_evidence_items')
          and contype = 'f'
          and confrelid in (
            to_regclass('pilot.shadow_library_sources'),
            to_regclass('pilot.shadow_library_documents'),
            to_regclass('pilot.shadow_library_chunks')
          )
          and pg_get_constraintdef(oid) not like '%library_organization_id%'
      )
    ) as library_scope_exclusive_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_shadow_evidence_items_library_scope_check'
        and conrelid = to_regclass('pilot.shadow_evidence_items')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%${PLATFORM_ORGANIZATION_ID}%'
        and pg_get_constraintdef(oid) like '%organization_id%'
    ) as library_scope_check_ready,
    (
      -- The bundle foreign key must still key on organization_id. Splitting the
      -- two meanings apart is only safe while the bundle half stays pinned to
      -- the asking gym; a mistake there would let one gym's item attach to
      -- another gym's bundle.
      select count(*) = 1
      from pg_constraint
      where conrelid = to_regclass('pilot.shadow_evidence_items')
        and contype = 'f'
        and confrelid = to_regclass('pilot.shadow_evidence_bundles')
        and pg_get_constraintdef(oid) like '%(bundle_id, organization_id, account_id)%'
    ) as bundle_foreign_key_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.shadow_evidence_items')
        and c.relname = 'idx_shadow_evidence_items_library_owner'
    ) as library_owner_index_ready,
    (
      -- "non athlete/user/individual specific" is the defining property of the
      -- baseline, and subject_id carries no foreign key on either table, so
      -- nothing but this check stands between a platform row and a real
      -- athlete's id.
      select count(*) = 2
      from pg_constraint
      where conname in (
          'pilot_shadow_library_documents_platform_unscoped_check',
          'pilot_shadow_library_chunks_platform_unscoped_check'
        )
        and contype = 'c'
        -- ILIKE, not LIKE. pg_get_constraintdef does not echo the migration's
        -- text back; it re-renders the parsed expression, and it renders
        -- operators in upper case. The migration says "subject_id is null" and
        -- Postgres reports "(subject_id IS NULL)", so the case-sensitive form of
        -- this predicate could never match and this assertion failed against a
        -- database where the constraint was present and correct.
        and pg_get_constraintdef(oid) ilike '%subject_id is null%'
        and pg_get_constraintdef(oid) like '%${PLATFORM_ORGANIZATION_ID}%'
    ) as platform_unscoped_ready,
    (
      -- The guards above are only meaningful if nothing already violates them.
      -- A pre-existing account in the reserved organization would have failed
      -- the ALTER, so reaching here with one present means the constraint was
      -- added NOT VALID by some other hand.
      select count(*) = 0
      from pilot.accounts
      where organization_id = '${PLATFORM_ORGANIZATION_ID}'
    ) as no_platform_members_ready
`;

function assertReadiness(row) {
  if (!row) {
    throw new Error('PLATFORM_LIBRARY_SCOPE_NOT_READY');
  }

  // Name the failing assertions. A bare error code sends the next operator back
  // into the SQL to guess which of twelve outcomes did not land, and two of them
  // -- library_scope_exclusive_ready and platform_unscoped_ready -- assert an
  // absence, which is the hardest kind to find by reading a migration that
  // reports only that it is unhappy.
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
    const readiness = await client.query(READINESS_QUERY);
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
