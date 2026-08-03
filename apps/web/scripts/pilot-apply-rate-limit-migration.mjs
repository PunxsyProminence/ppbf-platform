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

// This migration adopts a table that already exists in every deployed
// environment, created there by an unauthenticated login request rather than by
// any file in this repository. So readiness has to assert the SHAPE matches
// what the application expects, not merely that a relation of that name is
// present -- a name-only check would pass against a table whose columns had
// drifted and report an environment as migrated when the runtime and the schema
// disagree.
//
// `bucket_key_is_primary_key` is the load-bearing one. Every write in
// rateLimit.ts is an `insert ... on conflict (bucket_key) do update`, which
// requires a unique constraint on that column and fails at runtime without it.
// A table carrying the right four columns and no primary key would satisfy a
// column-count check and break every durable rate-limit write.
//
// `blocked_until_not_null` matters because the read path compares against it
// directly; a null there would make a bucket neither blocked nor expired.
//
// to_regclass() rather than the ::regclass cast throughout: the cast raises
// before any column is evaluated when the table is absent, which would report
// an unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.auth_rate_limit_buckets') is not null as table_ready,
    (
      select count(*) = 4
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'auth_rate_limit_buckets'
        and column_name in ('bucket_key', 'attempt_count', 'blocked_until', 'updated_at')
    ) as columns_ready,
    exists (
      select 1
      from pg_constraint
      where conrelid = to_regclass('pilot.auth_rate_limit_buckets')
        and contype = 'p'
        and pg_get_constraintdef(oid) like '%(bucket_key)%'
    ) as bucket_key_is_primary_key,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'auth_rate_limit_buckets'
        and column_name = 'blocked_until'
        and data_type = 'timestamp with time zone'
        and is_nullable = 'NO'
    ) as blocked_until_not_null,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'auth_rate_limit_buckets'
        and column_name = 'attempt_count'
        and data_type = 'integer'
        and is_nullable = 'NO'
    ) as attempt_count_not_null,
    exists (
      select 1
      from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_auth_rate_limit_buckets_blocked_until'
    ) as sweep_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('RATE_LIMIT_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_rate_limit_migration.sql',
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
  console.log(`Applied rate limit migration: ${migrationPath}`);
  console.log('PILOT RATE LIMIT MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT RATE LIMIT MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
