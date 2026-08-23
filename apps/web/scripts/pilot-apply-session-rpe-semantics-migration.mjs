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

// Asserts the properties the migration exists for, not merely that a column by
// that name appeared.
//
// `rpe_nullable_ready` is the one the whole change rests on. While rpe was NOT
// NULL, check-in could not write a session row without producing a number it
// did not have, which is exactly why a pre-session readiness value ended up in
// a column named for session RPE. If this reverts, the defect returns with it.
//
// `rpe_method_no_default_ready` is the one that would be easiest to lose and
// worst to lose, for the same reason the readiness-provenance runner says so:
// an rpe_method column still carrying its 'UNKNOWN' default satisfies every
// name-and-type check here while letting every future insert silently claim
// unknown provenance. The default exists only long enough for the rows already
// in the table to take it.
//
// `rpe_method_vocabulary_ready` matches QUOTED literals so a value cannot be
// satisfied by appearing inside the column name or inside another value.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// column is evaluated when the table is absent, which would report an
// unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.sessions') is not null as sessions_table_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'sessions'
        and column_name = 'rpe'
        and is_nullable = 'YES'
    ) as rpe_nullable_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'sessions'
        and column_name = 'rpe_method'
        and is_nullable = 'NO'
    ) as rpe_method_not_null_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'sessions'
        and column_name = 'rpe_method'
        and column_default is null
    ) as rpe_method_no_default_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_sessions_rpe_method_check'
        and conrelid = to_regclass('pilot.sessions')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%''UNKNOWN''%'
        and pg_get_constraintdef(oid) like '%''athlete_post_session_self_report''%'
    ) as rpe_method_vocabulary_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_sessions_rpe_method_agrees_with_value'
        and conrelid = to_regclass('pilot.sessions')
        and contype = 'c'
    ) as method_agreement_ready,
    not exists (
      select 1 from pilot.sessions where rpe_method is null or btrim(rpe_method) = ''
    ) as every_row_states_a_method
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('SESSION_RPE_SEMANTICS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_session_rpe_semantics_migration.sql',
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
  console.log(`Applied session RPE semantics migration: ${migrationPath}`);
  console.log('PILOT SESSION RPE SEMANTICS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SESSION RPE SEMANTICS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
