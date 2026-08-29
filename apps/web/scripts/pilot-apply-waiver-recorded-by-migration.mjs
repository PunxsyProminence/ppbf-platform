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

// Asserts the properties the migration exists for, not merely that a column
// by that name appeared.
//
// `column_nullable_ready` checks the column is NULLABLE, and that is the
// unusual direction on purpose. Most runners here assert NOT NULL. Unrecorded
// entry is a real and permanent state for every row written before this
// migration, so a future edit tightening this to NOT NULL could only be
// satisfied by backfilling an account nobody recorded -- the one thing this
// column exists to avoid. The runner refuses that edit rather than trusting
// nobody makes it.
//
// `fk_ready` is separate from the column check because the column and its
// foreign key are added by two different statements, and a database that got
// the first without the second would accept any string as an account id while
// reading as migrated.
//
// It also pins confdeltype = 'n' (SET NULL) rather than settling for "a
// constraint by that name exists". The migration's own comment sets out why
// the delete action is the load-bearing part: the retention purge hard-deletes
// parent accounts, and a restricting foreign key here aborts the whole sweep.
// The constraint is created inside an `if not exists (conname ...)` guard, so
// a database that already carried an earlier, restricting version of this
// constraint would keep it and the migration would report success. This is the
// assertion that refuses that database instead.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// column is evaluated when the table is absent, which would report an
// unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.waivers') is not null as table_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'waivers'
        and column_name = 'recorded_by_account_id'
        and data_type = 'text'
    ) as column_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'waivers'
        and column_name = 'recorded_by_account_id'
        and is_nullable = 'YES'
    ) as column_nullable_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_waivers_recorded_by_fk'
        and conrelid = to_regclass('pilot.waivers')
        and contype = 'f'
        and confdeltype = 'n'
    ) as fk_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'waivers'
        and column_name = 'signed_by_name'
    ) as signer_column_intact
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('WAIVER_RECORDED_BY_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_waiver_recorded_by_migration.sql',
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
  console.log(`Applied waiver recorded-by migration: ${migrationPath}`);
  console.log('PILOT WAIVER RECORDED BY MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT WAIVER RECORDED BY MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
