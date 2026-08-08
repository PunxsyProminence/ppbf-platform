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
    to_regclass('pilot.assessment_protocols') is not null as assessment_protocols_table_ready,
    to_regclass('pilot.data_collection_requests') is not null as data_collection_requests_table_ready,
    (
      select count(*) = 11
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'assessments'
        and column_name in (
          'protocol_id', 'protocol_version', 'administration_kind', 'due_on', 'administered_on',
          'retest_of_assessment_id', 'training_hours_at_administration', 'assessor_role',
          'second_rater_account_id', 'second_rater_result', 'conditions_note'
        )
    ) as assessments_columns_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_assessments_protocol_fk'
        and conrelid = to_regclass('pilot.assessments')
        and contype = 'f'
        and pg_get_constraintdef(oid) like '%(organization_id, protocol_id, protocol_version)%'
    ) as assessments_protocol_fk_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot' and indexname = 'pilot_assessments_due'
    ) as assessments_due_index_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_dcr_captured'
        and conrelid = to_regclass('pilot.data_collection_requests')
    ) as data_collection_requests_captured_check_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_dcr_subject'
        and conrelid = to_regclass('pilot.data_collection_requests')
    ) as data_collection_requests_subject_check_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.assessment_protocols')
        and c.relname = 'pilot_assessment_protocols_one_active_name'
        and i.indisunique
        and i.indpred is not null
    ) as assessment_protocols_one_active_name_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('ASSESSMENT_PROTOCOLS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_assessment_protocols_migration.sql',
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
  console.log(`Applied assessment protocols migration: ${migrationPath}`);
  console.log('PILOT ASSESSMENT PROTOCOLS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ASSESSMENT PROTOCOLS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
