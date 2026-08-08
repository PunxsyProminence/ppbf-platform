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
    to_regclass('pilot.source_retraction_checks') is not null as source_retraction_checks_table_ready,
    to_regclass('pilot.v_source_retraction_status') is not null as retraction_status_view_ready,
    to_regclass('pilot.v_sources_needing_retraction_check') is not null as needing_check_view_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_src_retraction_pkey'
        and conrelid = to_regclass('pilot.source_retraction_checks')
    ) as pkey_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_src_retraction_evidence'
        and conrelid = to_regclass('pilot.source_retraction_checks')
    ) as evidence_check_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_src_retraction_disposition'
        and conrelid = to_regclass('pilot.source_retraction_checks')
    ) as disposition_check_ready,
    to_regclass('pilot.pilot_src_retraction_source') is not null as source_index_ready,
    to_regclass('pilot.pilot_src_retraction_open') is not null as open_index_ready,
    coalesce((
      select reloptions @> array['security_invoker=true']
      from pg_class where oid = to_regclass('pilot.v_source_retraction_status')
    ), false) as retraction_status_security_invoker_ready,
    coalesce((
      select reloptions @> array['security_invoker=true']
      from pg_class where oid = to_regclass('pilot.v_sources_needing_retraction_check')
    ), false) as needing_check_security_invoker_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'shadow_library_sources'
        and column_name = 'retrieval_suppressed'
    ) as retrieval_suppressed_column_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'shadow_library_sources'
        and column_name = 'suppression_reason'
    ) as suppression_reason_column_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'shadow_library_sources'
        and column_name = 'suppressed_at'
    ) as suppressed_at_column_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'shadow_library_sources'
        and column_name = 'suppressed_by_account_id'
    ) as suppressed_by_account_id_column_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_library_sources_suppression_reason'
        and conrelid = to_regclass('pilot.shadow_library_sources')
    ) as suppression_reason_check_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('RETRACTION_SURVEILLANCE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_retraction_surveillance_migration.sql',
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
  console.log(`Applied retraction surveillance migration: ${migrationPath}`);
  console.log('PILOT RETRACTION SURVEILLANCE MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT RETRACTION SURVEILLANCE MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
