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

// Asserts the properties the migration exists for, not merely that columns by
// those names appeared: every column nullable with no default (an open
// session and every pre-migration row stay NULL; no default stamps a
// fabricated close), the right types, and both checks present with the
// vocabulary and the inactivity rule they are meant to enforce.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// column is evaluated when the table is absent, which would report an
// unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.sessions') is not null as sessions_table_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'sessions'
        and column_name = 'checked_out_at'
        and data_type = 'timestamp with time zone'
        and is_nullable = 'YES' and column_default is null
    ) as checked_out_at_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'sessions'
        and column_name = 'close_method'
        and data_type = 'text'
        and is_nullable = 'YES' and column_default is null
    ) as close_method_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'sessions'
        and column_name = 'last_activity_at'
        and data_type = 'timestamp with time zone'
        and is_nullable = 'YES' and column_default is null
    ) as last_activity_at_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'sessions'
        and column_name = 'inactivity_minutes'
        and data_type = 'integer'
        and is_nullable = 'YES' and column_default is null
    ) as inactivity_minutes_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_sessions_close_method_check'
        and conrelid = to_regclass('pilot.sessions')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%athlete_check_out%'
        and pg_get_constraintdef(oid) like '%staff_check_out%'
        and pg_get_constraintdef(oid) like '%auto_inactivity%'
    ) as close_method_check_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_sessions_close_record_check'
        and conrelid = to_regclass('pilot.sessions')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%checked_out_at IS NOT NULL%'
        and pg_get_constraintdef(oid) like '%last_activity_at IS NOT NULL%'
        and pg_get_constraintdef(oid) like '%(inactivity_minutes >= 1)%'
        and pg_get_constraintdef(oid) like '%(inactivity_minutes <= 1440)%'
    ) as close_record_check_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('SESSION_CLOSE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_session_close_migration.sql',
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
  console.log(`Applied session close migration: ${migrationPath}`);
  console.log('PILOT SESSION CLOSE MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SESSION CLOSE MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
