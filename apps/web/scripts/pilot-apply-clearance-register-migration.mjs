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
    to_regclass('pilot.clearance_types') is not null as clearance_types_table_ready,
    to_regclass('pilot.person_clearances') is not null as person_clearances_table_ready,
    to_regclass('pilot.activity_clearance_requirements') is not null as activity_clearance_requirements_table_ready,
    to_regclass('pilot.v_clearance_status') is not null as v_clearance_status_view_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_person_clearances_current'
        and conrelid = to_regclass('pilot.person_clearances')
    ) as person_clearances_current_check_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.activity_clearance_requirements')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%activity_scope%'
        and pg_get_constraintdef(oid) like '%''supervise_sparring''%'
        and pg_get_constraintdef(oid) like '%''unsupervised_youth_contact''%'
    ) as activity_scope_vocabulary_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.person_clearances')
        and c.relname = 'pilot_person_clearances_expiring'
    ) as person_clearances_expiring_index_ready,
    (
      -- The view's own defining query, not a data probe: proves the view
      -- is READ-ONLY (advisory display) with no write path, since a view
      -- has no INSERT/UPDATE/DELETE target unless one is separately
      -- defined, and none is defined here.
      select is_updatable = 'NO'
      from information_schema.views
      where table_schema = 'pilot' and table_name = 'v_clearance_status'
    ) as v_clearance_status_read_only_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('CLEARANCE_REGISTER_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_clearance_register_migration.sql',
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
  console.log(`Applied clearance register migration: ${migrationPath}`);
  console.log('PILOT CLEARANCE REGISTER MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT CLEARANCE REGISTER MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
