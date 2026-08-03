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

const READINESS_QUERY = `
  select
    to_regclass('pilot.account_profiles') is not null as account_profiles_ready,
    -- Asserted column by column rather than as a table-exists check: the
    -- failure this guards against is an environment that got an earlier cut of
    -- the table and would otherwise report "ready" while the roster read
    -- referenced columns that are not there.
    (
      select count(*) = 16
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'account_profiles'
        and column_name in (
          'organization_id', 'account_id', 'display_nickname',
          'nickname_cleared_at', 'nickname_cleared_by_account_id',
          'corner', 'program',
          'photo_blob_path', 'photo_content_type', 'photo_bytes',
          'photo_width', 'photo_height', 'photo_sha256', 'photo_uploaded_at',
          'photo_review_state', 'photo_reviewed_by_account_id'
        )
    ) as account_profiles_columns_ready,
    -- The three CHECKs are the schema's half of the privacy posture: a corner
    -- outside the vocabulary, a photo released without anything having reviewed
    -- it, or a content type this platform cannot strip metadata from all have to
    -- be impossible at the table, not only at the route.
    exists (
      select 1 from pg_constraint
      where conrelid = 'pilot.account_profiles'::regclass
        and pg_get_constraintdef(oid) like '%corner%red%'
    ) as corner_check_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = 'pilot.account_profiles'::regclass
        and pg_get_constraintdef(oid) like '%pending_review%'
    ) as review_state_check_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = 'pilot.account_profiles'::regclass
        and pg_get_constraintdef(oid) like '%youth_mentorship%'
    ) as program_check_ready,
    exists (
      select 1
      from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_account_profiles_org'
    ) as account_profiles_org_index_ready,
    exists (
      select 1
      from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_account_profiles_pending_review'
    ) as account_profiles_review_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('ACCOUNT_PROFILES_TABLE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_profile_identity_migration.sql',
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
  console.log(`Applied profile_identity migration: ${migrationPath}`);
  console.log('PILOT PROFILE IDENTITY MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT PROFILE IDENTITY MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
