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

// Asserts, on both tables, the column's type, NOT NULL and '{}' default, and the object check, so
// an environment that got a column without its check -- or nullable, or with another default --
// cannot pass readiness; and that the duration check and pilot_wti_one_source hold their NEW
// definitions (1 to 180 minutes; a drill, free text or non-empty details), not the old ones.
const READINESS_QUERY = `
  select
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'workout_templates'
        and column_name = 'details' and data_type = 'jsonb'
        and is_nullable = 'NO' and column_default = '''{}''::jsonb'
    ) as template_details_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.workout_templates')
        and conname = 'pilot_workout_templates_details_check'
    ) as template_details_check_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'workout_template_items'
        and column_name = 'details' and data_type = 'jsonb'
        and is_nullable = 'NO' and column_default = '''{}''::jsonb'
    ) as item_details_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.workout_template_items')
        and conname = 'pilot_wti_details_check'
    ) as item_details_check_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.workout_templates')
        and conname = 'workout_templates_duration_minutes_check'
        and pg_get_constraintdef(oid) like '%(duration_minutes >= 1)%'
        and pg_get_constraintdef(oid) like '%(duration_minutes <= 180)%'
    ) as duration_range_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.workout_template_items')
        and conname = 'pilot_wti_one_source'
        and pg_get_constraintdef(oid) like '%drill_id IS NOT NULL%'
        and pg_get_constraintdef(oid) like '%free_text_drill IS NOT NULL%'
        and pg_get_constraintdef(oid) like '%details%'
    ) as one_source_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('WORKOUT_TEMPLATE_DETAILS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_workout_template_details_migration.sql',
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
  console.log(`Applied workout template details migration: ${migrationPath}`);
  console.log('PILOT WORKOUT TEMPLATE DETAILS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT WORKOUT TEMPLATE DETAILS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
