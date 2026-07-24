import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

const MIGRATION_LOCK = 'ppbf_shadow_runtime_migration_v1';

const READINESS_QUERY = `
  select
    to_regclass('pilot.shadow_chat_sessions') is not null as chat_sessions_ready,
    to_regclass('pilot.shadow_chat_messages') is not null as chat_messages_ready,
    to_regclass('pilot.shadow_jobs') is not null as jobs_ready,
    to_regclass('pilot.shadow_learning_events') is not null as learning_events_ready,
    to_regclass('pilot.shadow_formula_observations') is not null as formula_observations_ready,
    to_regclass('pilot.shadow_formula_results') is not null as formula_results_ready,
    to_regclass('pilot.shadow_rate_limit_buckets') is not null as rate_limit_buckets_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_chat_messages'
        and column_name = 'topic'
    ) as message_topic_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_chat_messages'
        and column_name = 'session_type'
    ) as message_session_type_ready,
    exists (
      select 1
      from pg_indexes
      where schemaname = 'pilot'
        and tablename = 'shadow_feedback'
        and indexname = 'idx_shadow_feedback_unique_message'
    ) as feedback_correlation_ready
`;

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`MISSING_${name}`);
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
  if (
    process.env.NODE_ENV === 'test'
    && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true'
  ) {
    return false;
  }
  return { rejectUnauthorized: true };
}

function stripLeadingSqlComments(sql) {
  return sql
    .replace(/^\uFEFF/, '')
    .trimStart()
    .replace(/^(?:--[^\r\n]*(?:\r?\n|$)\s*)+/, '');
}

export function assertTransactionalMigration(sql) {
  const normalized = stripLeadingSqlComments(sql).trim();
  if (!/^begin\s*;/i.test(normalized) || !/commit\s*;\s*$/i.test(normalized)) {
    throw new Error('MIGRATION_TRANSACTION_BOUNDARY_MISSING');
  }
}

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('SHADOW_SCHEMA_NOT_READY');
  }
}

export async function applyShadowRuntimeMigration(client, sql) {
  assertTransactionalMigration(sql);
  await client.query('select pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK]);
  try {
    try {
      await client.query(sql);
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }

    const readiness = await client.query(READINESS_QUERY);
    assertReadiness(readiness.rows[0]);
  } finally {
    await client
      .query('select pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK])
      .catch(() => {});
  }
}

export async function run() {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  const expectedHostname = required('PPBF_EXPECTED_POSTGRES_HOSTNAME');
  const expectedDatabase = required('PPBF_EXPECTED_POSTGRES_DATABASE');
  delete process.env.AZURE_POSTGRES_CONNECTION_STRING;

  const target = parseConnectionTarget(connectionString);
  assertExpectedTarget(target, expectedHostname, expectedDatabase);

  const scriptPath = fileURLToPath(import.meta.url);
  const migrationPath = path.resolve(
    path.dirname(scriptPath),
    '../../../infra/azure/pilot_slice_postgres_shadow_runtime_migration.sql',
  );
  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  try {
    await applyShadowRuntimeMigration(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log('shadow_schema_ready: true');
  console.log('PILOT SHADOW RUNTIME MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch {
    console.error('PILOT SHADOW RUNTIME MIGRATION FAIL');
    process.exit(1);
  }
}
