// Applies the medical administrative clearance expiry migration.
//
// Adds pilot.shadow_medical_administrative_status.expires_at, the time bound
// the clearance gates read. Must run AFTER shadow-decision-loop, which creates
// the table.
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
// `column_nullable_ready` is an assertion, not an oversight. A NOT NULL variant
// would mean this migration had chosen a clinical validity window for every
// child on the roster -- the one decision it explicitly refuses to make (see
// the migration's own header, and docs/HANDOFF_RESEARCH.md item 1). If a later
// change makes this column NOT NULL it must be because an owner supplied that
// interval, and this runner should be the thing that notices.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// column is evaluated when the table is absent, which would report an
// unmigrated database (shadow-decision-loop never applied) as a SQL error
// instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.shadow_medical_administrative_status') is not null as status_table_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_medical_administrative_status'
        and column_name = 'expires_at'
        and data_type = 'timestamp with time zone'
    ) as column_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_medical_administrative_status'
        and column_name = 'expires_at'
        and is_nullable = 'YES'
    ) as column_nullable_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'shadow_medical_status_expires_after_effective_check'
        and conrelid = 'pilot.shadow_medical_administrative_status'::regclass
    ) as constraint_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_medical_administrative_status'
        and column_name = 'status'
        and is_nullable = 'NO'
    ) as existing_columns_untouched_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('MEDICAL_CLEARANCE_EXPIRY_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_medical_clearance_expiry_migration.sql',
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
  console.log(`Applied medical clearance expiry migration: ${migrationPath}`);
  console.log('PILOT MEDICAL CLEARANCE EXPIRY MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT MEDICAL CLEARANCE EXPIRY MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
