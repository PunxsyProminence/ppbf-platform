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

// Asserts the table, its read index and every guard ON THIS TABLE (looked up
// by conrelid, not by name alone), so an environment where the table exists
// without one of its checks or its athlete foreign key cannot pass readiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.medical_restrictions') is not null as medical_restrictions_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot' and tablename = 'medical_restrictions'
        and indexname = 'idx_medical_restrictions_athlete'
    ) as athlete_index_ready,
    (
      select count(*) = 10 from pg_constraint
      where conrelid = to_regclass('pilot.medical_restrictions')
        and conname in (
          'pilot_medical_restrictions_source_check',
          'pilot_medical_restrictions_loc_check',
          'pilot_medical_restrictions_incident_check',
          'pilot_medical_restrictions_note_check',
          'pilot_medical_restrictions_athlete_fk',
          'pilot_medical_restrictions_dates_check',
          'pilot_medical_restrictions_recorded_role_check',
          'pilot_medical_restrictions_release_check',
          'pilot_medical_restrictions_lbc_check',
          'pilot_medical_restrictions_void_check'
        )
    ) as guards_ready,
    exists (
      select 1 from pg_trigger
      where tgrelid = to_regclass('pilot.medical_restrictions')
        and tgname = 'trg_medical_restrictions_guard'
        and not tgisinternal and tgenabled <> 'D'
    ) as guard_trigger_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('MEDICAL_RESTRICTIONS_TABLE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_medical_restrictions_migration.sql',
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
  console.log(`Applied medical restrictions migration: ${migrationPath}`);
  console.log('PILOT MEDICAL RESTRICTIONS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT MEDICAL RESTRICTIONS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
