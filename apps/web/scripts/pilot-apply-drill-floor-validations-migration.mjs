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

// Readiness asserts the table, its two foreign keys, its role CHECK and its
// index are all in place, not merely that something by the name exists.
const READINESS_QUERY = `
  select
    to_regclass('pilot.drill_library') is not null as drill_library_table_ready,
    to_regclass('pilot.drill_floor_validations') is not null as table_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_floor_validations_drill_fk'
        and conrelid = to_regclass('pilot.drill_floor_validations')
        and contype = 'f'
        and confrelid = to_regclass('pilot.drill_library')
        and pg_get_constraintdef(oid) like '%(organization_id, drill_id)%'
        and pg_get_constraintdef(oid) like '%ON DELETE CASCADE%'
    ) as drill_fk_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.drill_floor_validations')
        and contype = 'f'
        and confrelid = to_regclass('pilot.organizations')
        and pg_get_constraintdef(oid) like '%ON DELETE CASCADE%'
    ) as organization_fk_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_floor_validations_role_check'
        and conrelid = to_regclass('pilot.drill_floor_validations')
        and pg_get_constraintdef(oid) like '%coach%'
        and pg_get_constraintdef(oid) like '%organization_admin%'
    ) as role_check_ready,
    to_regclass('pilot.idx_pilot_drill_floor_validations_org_drill_newest') is not null as index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('DRILL_FLOOR_VALIDATIONS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_drill_floor_validations_migration.sql',
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
  console.log(`Applied drill floor validations migration: ${migrationPath}`);
  console.log('PILOT DRILL FLOOR VALIDATIONS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT DRILL FLOOR VALIDATIONS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
