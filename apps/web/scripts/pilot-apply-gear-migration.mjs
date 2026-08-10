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

// The key is (organization_id, product_id), and the readiness query asserts
// that rather than merely that a table exists. Every gym has its own catalogue,
// its own suppliers and its own prices; a product_id-only key would collide two
// gyms' equipment and make one gym's wholesale cost the other's.
//
// cost_is_integer_cents matters for the same class of reason: money as float
// drifts, and a catalogue that drifts a cent per operation produces a margin
// report that will not reconcile against a bank statement.
//
// to_regclass() rather than the ::regclass cast throughout: the cast raises
// before any column is evaluated when the table is absent, which would report
// an unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.gear_products') is not null as table_ready,
    (
      select count(*) = 12
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'gear_products'
        and column_name in (
          'organization_id', 'product_id', 'name', 'description', 'category',
          'wholesale_cost_cents', 'retail_price_cents', 'listed_publicly',
          'availability', 'checkout_url', 'created_at', 'updated_at'
        )
    ) as columns_ready,
    exists (
      select 1
      from pg_constraint
      where conrelid = to_regclass('pilot.gear_products')
        and contype = 'p'
        and pg_get_constraintdef(oid) like '%(organization_id, product_id)%'
    ) as key_is_org_scoped,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'gear_products'
        and column_name = 'wholesale_cost_cents'
        and data_type = 'integer'
    ) as cost_is_integer_cents,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_gear_products_availability_check'
        and conrelid = to_regclass('pilot.gear_products')
        and pg_get_constraintdef(oid) like '%''in_stock''%'
        and pg_get_constraintdef(oid) like '%''order_only''%'
        and pg_get_constraintdef(oid) like '%''unavailable''%'
    ) as availability_vocabulary_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_gear_products_cost_nonneg'
        and conrelid = to_regclass('pilot.gear_products')
    ) as cost_nonneg_ready,
    exists (
      select 1
      from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_pilot_gear_products_listed'
    ) as public_store_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('GEAR_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_gear_migration.sql',
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
  console.log(`Applied gear migration: ${migrationPath}`);
  console.log('PILOT GEAR MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT GEAR MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
