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

// Asserts real properties, not merely that a table appeared. Each clause below
// corresponds to a way this migration could apply and still leave the feature
// broken or unsafe:
//
//   key_is_org_scoped        a vendor_id-only key would collide two gyms'
//                            accounts with the same supplier and make one
//                            gym's negotiated terms the other's.
//
//   net_terms_is_integer     terms are a whole number of days. Text here would
//                            let "30 days" and "net 30" both be stored and
//                            neither be comparable.
//
//   no_credential_column     THE ONE THAT MATTERS MOST. There is no password
//                            column on this table and there must never be one:
//                            a supplier portal login held in a youth records
//                            platform is a credential nobody rotates, readable
//                            by every organization admin. A later migration
//                            that adds one fails here rather than shipping
//                            quietly. Deliberately a pattern match on the
//                            column name rather than a fixed list, because the
//                            column somebody eventually adds will not be
//                            called the name this file guessed.
//
//   brand_is_public_text /   the two halves of the design decision. A brand is
//   vendor_column_ready      public free text on the product; the vendor id is
//                            an internal reference. Both must exist, or the
//                            store loses the brand and the Treasurer loses the
//                            account.
//
//   vendor_fk_is_org_scoped  the foreign key must be composite. A vendor_id-only
//                            reference would let one gym's product name another
//                            gym's supplier account.
//
// to_regclass() rather than the ::regclass cast throughout: the cast raises
// before any column is evaluated when the table is absent, which would report
// an unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.gear_vendors') is not null as table_ready,
    (
      select count(*) = 14
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'gear_vendors'
        and column_name in (
          'organization_id', 'vendor_id', 'vendor_name', 'account_number',
          'discount_tier', 'net_terms_days', 'notes', 'portal_url',
          'rep_name', 'rep_email', 'rep_phone', 'active',
          'created_at', 'updated_at'
        )
    ) as columns_ready,
    exists (
      select 1
      from pg_constraint
      where conrelid = to_regclass('pilot.gear_vendors')
        and contype = 'p'
        and pg_get_constraintdef(oid) like '%(organization_id, vendor_id)%'
    ) as key_is_org_scoped,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'gear_vendors'
        and column_name = 'account_number'
        and data_type = 'text'
    ) as account_number_is_text,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'gear_vendors'
        and column_name = 'net_terms_days'
        and data_type = 'integer'
    ) as net_terms_is_integer,
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'gear_vendors'
        and (
          column_name like '%password%'
          or column_name like '%passwd%'
          or column_name like '%secret%'
          or column_name like '%credential%'
          or column_name like '%api_key%'
          or column_name like '%access_token%'
        )
    ) as no_credential_column,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_gear_vendors_net_terms_sane'
        and conrelid = to_regclass('pilot.gear_vendors')
    ) as net_terms_check_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'gear_products'
        and column_name = 'brand'
        and data_type = 'text'
        and is_nullable = 'NO'
    ) as brand_is_public_text,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'gear_products'
        and column_name = 'vendor_id'
        and data_type = 'text'
        and is_nullable = 'YES'
    ) as vendor_column_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_gear_products_vendor_fk'
        and conrelid = to_regclass('pilot.gear_products')
        and contype = 'f'
        and confrelid = to_regclass('pilot.gear_vendors')
        and pg_get_constraintdef(oid) like '%(organization_id, vendor_id)%'
    ) as vendor_fk_is_org_scoped,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_gear_products_vendor_id_not_blank'
        and conrelid = to_regclass('pilot.gear_products')
    ) as vendor_id_blank_check_ready,
    exists (
      select 1
      from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_pilot_gear_products_vendor'
    ) as vendor_lookup_index_ready,
    exists (
      select 1
      from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_pilot_gear_vendors_active'
    ) as vendor_list_index_ready
`;

export function assertReadiness(row) {
  if (!row) {
    throw new Error('GEAR_VENDORS_NOT_READY');
  }
  const failed = Object.entries(row)
    .filter(([, value]) => value !== true)
    .map(([name]) => name);
  if (failed.length > 0) {
    // Named rather than a bare code: "GEAR_VENDORS_NOT_READY" alone sent the
    // last operator to read the whole SQL file to find out which property was
    // missing.
    throw new Error(`GEAR_VENDORS_NOT_READY: ${failed.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_gear_vendors_migration.sql',
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
  console.log(`Applied gear vendors migration: ${migrationPath}`);
  console.log('PILOT GEAR VENDORS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT GEAR VENDORS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
