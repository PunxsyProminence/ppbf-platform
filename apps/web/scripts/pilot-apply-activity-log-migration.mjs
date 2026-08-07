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

const READINESS_QUERY = `
  select
    to_regclass('pilot.activity_log') is not null as activity_log_table_ready,
    to_regclass('pilot.sparring_rounds') is not null as sparring_rounds_table_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.activity_log')
        and c.relname = 'pilot_activity_log_one_per_occurrence'
        and i.indisunique
    ) as activity_log_one_per_occurrence_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_activity_log_domain_check'
        and conrelid = to_regclass('pilot.activity_log')
        and pg_get_constraintdef(oid) like '%''boxing_training''%'
        and pg_get_constraintdef(oid) like '%''community_service''%'
        and pg_get_constraintdef(oid) like '%''work_study''%'
    ) as activity_log_domain_vocabulary_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_activity_log_verified_check'
        and conrelid = to_regclass('pilot.activity_log')
    ) as activity_log_verified_check_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_sparring_rounds_type_check'
        and conrelid = to_regclass('pilot.sparring_rounds')
        and pg_get_constraintdef(oid) like '%''hard''%'
        and pg_get_constraintdef(oid) like '%''conditioned''%'
    ) as sparring_rounds_type_vocabulary_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_sparring_rounds_activity_fk'
        and conrelid = to_regclass('pilot.sparring_rounds')
        and contype = 'f'
    ) as sparring_rounds_activity_fk_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'sparring_rounds' and column_name = 'duration_sec'
    ) as sparring_rounds_duration_column_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('ACTIVITY_LOG_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_activity_log_migration.sql',
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
  console.log(`Applied activity log migration: ${migrationPath}`);
  console.log('PILOT ACTIVITY LOG MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ACTIVITY LOG MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
