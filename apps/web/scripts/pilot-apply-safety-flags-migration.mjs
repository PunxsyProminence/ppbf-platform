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
    to_regclass('pilot.safety_flags') is not null as safety_flags_table_ready,
    to_regclass('pilot.v_flag_calibration') is not null as flag_calibration_view_ready,
    to_regclass('pilot.return_to_training_plans') is not null as rtt_plans_table_ready,
    to_regclass('pilot.return_to_training_steps') is not null as rtt_steps_table_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_safety_flags_note_required'
        and conrelid = to_regclass('pilot.safety_flags')
    ) as safety_flags_note_required_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_safety_flags_external_not_bypassed'
        and conrelid = to_regclass('pilot.safety_flags')
    ) as safety_flags_external_not_bypassed_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_safety_flags_medical_human_only'
        and conrelid = to_regclass('pilot.safety_flags')
        and pg_get_constraintdef(oid) like '%concussion_rest_period%'
    ) as safety_flags_medical_human_only_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_rtt_steps_advance'
        and conrelid = to_regclass('pilot.return_to_training_steps')
    ) as rtt_steps_advance_check_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_rtt_steps_week_uq'
        and conrelid = to_regclass('pilot.return_to_training_steps')
        and contype = 'u'
    ) as rtt_steps_week_unique_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('SAFETY_FLAGS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_safety_flags_migration.sql',
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
  console.log(`Applied safety flags / return-to-training migration: ${migrationPath}`);
  console.log('PILOT SAFETY FLAGS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SAFETY FLAGS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
