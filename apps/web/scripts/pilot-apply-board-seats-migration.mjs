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

// Asserts what the migration actually produced, not merely that a table by
// that name is present. The table alone would satisfy a check while the seat
// vocabulary or -- far worse -- the single-primary index was missing, and an
// environment that admits two Presidents for one gym is the failure this
// migration exists to prevent.
//
// `single_primary_ready` therefore asserts the index is both UNIQUE and
// PARTIAL (indpred is not null). A plain unique index on (organization_id,
// seat) would pass a name-only check and would forbid the co-holders the board
// is entitled to.
//
// The vocabulary match is against the QUOTED literal ('%''chair''%'), because
// every slug but one is a substring of another slug or of the column name.
//
// to_regclass() rather than the ::regclass cast throughout: the cast raises
// before any column is evaluated when the table is absent, which would report
// an unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.board_seats') is not null as board_seats_ready,
    (
      select count(*) = 8
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'board_seats'
        and column_name in (
          'organization_id', 'seat', 'account_id', 'is_primary',
          'assigned_by_account_id', 'assigned_at', 'created_at', 'updated_at'
        )
    ) as board_seat_columns_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_board_seats_seat_check'
        and conrelid = to_regclass('pilot.board_seats')
        and pg_get_constraintdef(oid) like '%''president''%'
        and pg_get_constraintdef(oid) like '%''chair''%'
        and pg_get_constraintdef(oid) like '%''vice-chair''%'
        and pg_get_constraintdef(oid) like '%''treasurer''%'
        and pg_get_constraintdef(oid) like '%''secretary''%'
        and pg_get_constraintdef(oid) like '%''safety-director''%'
        and pg_get_constraintdef(oid) like '%''community-director''%'
        and pg_get_constraintdef(oid) like '%''at-large''%'
    ) as seat_vocabulary_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_board_seats_pkey'
        and conrelid = to_regclass('pilot.board_seats')
        and contype = 'p'
        and pg_get_constraintdef(oid) like '%(organization_id, seat, account_id)%'
    ) as seat_holder_key_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.board_seats')
        and c.relname = 'pilot_board_seats_one_primary_per_seat'
        and i.indisunique
        and i.indpred is not null
    ) as single_primary_ready,
    exists (
      select 1
      from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_pilot_board_seats_org_account'
    ) as account_seats_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('BOARD_SEATS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_board_seats_migration.sql',
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
  console.log(`Applied board seats migration: ${migrationPath}`);
  console.log('PILOT BOARD SEATS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT BOARD SEATS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
