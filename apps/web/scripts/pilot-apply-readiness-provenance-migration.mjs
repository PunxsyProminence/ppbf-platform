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

// Asserts the properties the migration exists for, not merely that some
// columns by those names appeared.
//
// `method_no_default_ready` is the one that would be easiest to lose and worst
// to lose. The whole argument of this migration is that a readiness row cannot
// be written without stating where it came from. A `method` column that still
// carries its 'UNKNOWN' default satisfies every name-and-type check here while
// letting every future insert silently claim unknown provenance -- which is
// exactly the state being fixed. The default exists only long enough for the
// existing rows to take it.
//
// `method_vocabulary_ready` matches QUOTED literals so a value cannot be
// satisfied by appearing inside the column name or inside another value.
//
// `properties_default_ready` asserts the three measurement-property columns
// DO still default toward "not established". Those defaults are safe in the
// direction they fail; losing them would let a row assert nothing about the
// method's validation and read as though the question had been answered.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// column is evaluated when the table is absent, which would report an
// unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.readiness') is not null as readiness_table_ready,
    (
      select count(*) = 5
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'readiness'
        and column_name in ('method', 'reliability_status', 'validity_status',
                            'evidence_class', 'recorded_by_account_id')
    ) as columns_ready,
    (
      select count(*) = 4
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'readiness'
        and column_name in ('method', 'reliability_status', 'validity_status', 'evidence_class')
        and is_nullable = 'NO'
    ) as columns_not_null_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'readiness'
        and column_name = 'method'
        and column_default is null
    ) as method_no_default_ready,
    (
      select count(*) = 3
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'readiness'
        and column_name in ('reliability_status', 'validity_status', 'evidence_class')
        and column_default is not null
    ) as properties_default_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_readiness_method_check'
        and conrelid = to_regclass('pilot.readiness')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%''UNKNOWN''%'
        and pg_get_constraintdef(oid) like '%''staff_entered_intake''%'
    ) as method_vocabulary_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_readiness_recorded_by_fk'
        and conrelid = to_regclass('pilot.readiness')
        and contype = 'f'
    ) as recorded_by_fk_ready,
    not exists (
      select 1 from pilot.readiness where method is null or btrim(method) = ''
    ) as every_row_states_a_method
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('READINESS_PROVENANCE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_readiness_provenance_migration.sql',
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
  console.log(`Applied readiness provenance migration: ${migrationPath}`);
  console.log('PILOT READINESS PROVENANCE MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT READINESS PROVENANCE MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
