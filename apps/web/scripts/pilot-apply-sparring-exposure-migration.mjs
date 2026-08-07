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
    to_regclass('pilot.sparring_exposure') is not null as sparring_exposure_table_ready,
    to_regclass('pilot.session_load') is not null as session_load_table_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_sparring_exposure_type_check'
        and conrelid = to_regclass('pilot.sparring_exposure')
        and pg_get_constraintdef(oid) like '%''hard''%'
        and pg_get_constraintdef(oid) like '%''conditioned''%'
    ) as sparring_exposure_type_vocabulary_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_sparring_exposure_stop'
        and conrelid = to_regclass('pilot.sparring_exposure')
    ) as sparring_exposure_stop_check_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_sparring_exposure_segment_uq'
        and conrelid = to_regclass('pilot.sparring_exposure')
        and contype = 'u'
    ) as sparring_exposure_segment_unique_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'session_load' and column_name = 'rpe_physical'
    ) as session_load_rpe_physical_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'session_load' and column_name = 'rpe_cognitive'
    ) as session_load_rpe_cognitive_ready,
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'session_load'
        and column_name in ('derived_load', 'srpe_load', 'computed_load')
    ) as session_load_no_stored_derived_column,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_session_load_rated_by_uq'
        and conrelid = to_regclass('pilot.session_load')
        and contype = 'u'
    ) as session_load_rated_by_unique_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('SPARRING_EXPOSURE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_sparring_exposure_and_load_migration.sql',
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
  console.log(`Applied sparring exposure / session load migration: ${migrationPath}`);
  console.log('PILOT SPARRING EXPOSURE MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SPARRING EXPOSURE MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
