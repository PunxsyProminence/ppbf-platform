import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the organization-profiles migration (lane L31, issue #1469) inside one transaction.
// The operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

const PROFILES = `to_regclass('pilot.organization_profiles')`;

/** The names of the columns in `keys` (conkey or confkey) of table `rel`, IN KEY ORDER. */
function keyColumns(keys, rel) {
  return `(
    select array_agg(a.attname::text order by k.ord)
      from unnest(${keys}) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = ${rel} and a.attnum = k.attnum
  )`;
}

function textArray(values) {
  return `array[${values.map((value) => `'${value.replace(/'/g, "''")}'`).join(', ')}]::text[]`;
}

// A VALIDATED check whose own text is exactly `definition`. Comparing the whole of it is what
// refuses a loosened check (a raised limit, a dropped name, "or true") that a pattern would pass.
function check(name, definition) {
  return `exists (
    select 1 from pg_constraint c
     where c.conrelid = ${PROFILES} and c.conname = '${name}' and c.contype = 'c' and c.convalidated
       and pg_get_constraintdef(c.oid) = '${definition.replace(/'/g, "''")}'
  )`;
}

// Required: no default, so an insert that leaves one out is refused rather than given a value.
const REQUIRED_COLUMNS = ['brand', 'short_name', 'common_name', 'website_url', 'domain'];
// Optional: default '' (so "not given" is one value, never null or absent).
const OPTIONAL_COLUMNS = [
  'ein', 'contact_email', 'donations_email', 'grants_email', 'established', 'town',
  'service_area', 'service_area_short',
  'physical_street', 'physical_city', 'physical_region', 'physical_postal_code',
  'mailing_address', 'head_coach_name',
];

// Readiness asserts the result, not the attempt: every rule the migration creates is read back
// from the catalog, and a database that is missing one, or holds a looser one, is refused.
const READINESS_QUERY = `
  select
    ${PROFILES} is not null as table_ready,
    -- Every column: name, type and whether it may be null, in order. No account column.
    (
      select array_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end order by a.attnum)
        from pg_attribute a
       where a.attrelid = ${PROFILES} and a.attnum > 0 and not a.attisdropped
    ) = ${textArray([
      'organization_id text not null',
      ...[...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS].map((column) => `${column} text not null`),
      'created_at timestamp with time zone not null',
      'updated_at timestamp with time zone not null',
    ])} as columns_ready,
    -- Every default, column by column: '' on each optional field, now() on the two timestamps,
    -- and none on the key or the required fields.
    (
      select array_agg(a.attname || '=' || pg_get_expr(d.adbin, d.adrelid) order by a.attnum)
        from pg_attribute a
        join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where a.attrelid = ${PROFILES} and not a.attisdropped
    ) = ${textArray([
      ...OPTIONAL_COLUMNS.map((column) => `${column}=''::text`),
      'created_at=now()',
      'updated_at=now()',
    ])} as defaults_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = ${PROFILES} and c.conname = 'pilot_organization_profiles_pkey' and c.contype = 'p'
         and ${keyColumns('c.conkey', 'c.conrelid')} = ${textArray(['organization_id'])}
    ) as primary_key_ready,
    exists (
      -- Exactly organization_id -> organizations.organization_id, validated, cascading.
      select 1 from pg_constraint c
       where c.conrelid = ${PROFILES} and c.conname = 'pilot_organization_profiles_org_fk'
         and c.contype = 'f' and c.convalidated and not c.condeferrable
         and c.confrelid = to_regclass('pilot.organizations') and c.confdeltype = 'c'
         and ${keyColumns('c.conkey', 'c.conrelid')} = ${textArray(['organization_id'])}
         and ${keyColumns('c.confkey', 'c.confrelid')} = ${textArray(['organization_id'])}
    ) as organization_fk_ready,
    -- The table holds no other foreign key (no account column, so nothing for the purge).
    (select count(*) from pg_constraint c where c.conrelid = ${PROFILES} and c.contype = 'f') = 1 as only_fk_ready,
    ${check('pilot_organization_profiles_not_platform_check',
      "CHECK ((organization_id <> '__platform__'::text))")} as not_platform_ready,
    ${check('pilot_organization_profiles_names_check',
      "CHECK (((btrim(brand) <> ''::text) AND (btrim(short_name) <> ''::text) AND (btrim(common_name) <> ''::text)"
      + ' AND (char_length(brand) <= 200) AND (char_length(short_name) <= 40) AND (char_length(common_name) <= 200)))')} as names_check_ready,
    ${check('pilot_organization_profiles_web_check',
      "CHECK (((website_url ~* '^https://[a-z0-9-]+(\\.[a-z0-9-]+)+$'::text) AND (char_length(website_url) <= 200)"
      + " AND (domain ~* '^[a-z0-9-]+(\\.[a-z0-9-]+)+$'::text) AND (char_length(domain) <= 200)))")} as web_check_ready,
    ${check('pilot_organization_profiles_lengths_check',
      'CHECK (((char_length(ein) <= 20)'
      + ' AND (char_length(contact_email) <= 254) AND (char_length(donations_email) <= 254) AND (char_length(grants_email) <= 254)'
      + ' AND (char_length(established) <= 20) AND (char_length(town) <= 100)'
      + ' AND (char_length(service_area) <= 300) AND (char_length(service_area_short) <= 300)'
      + ' AND (char_length(physical_street) <= 200) AND (char_length(physical_city) <= 100)'
      + ' AND (char_length(physical_region) <= 50) AND (char_length(physical_postal_code) <= 20)'
      + ' AND (char_length(mailing_address) <= 300) AND (char_length(head_coach_name) <= 200)))')} as lengths_check_ready
`;

// Asked only once the table exists (a query naming a missing table fails to plan rather than
// answering false): where the operating organization exists, its profile row must exist.
const SEED_QUERY = `
  select (
    not exists (select 1 from pilot.organizations where organization_id = 'punxsy_prominence')
    or exists (select 1 from pilot.organization_profiles where organization_id = 'punxsy_prominence')
  ) as seed_ready
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    // Creating the table's foreign key takes a brief lock on pilot.organizations. Rather than
    // queue behind a long transaction already holding one, give up and let the operator re-run
    // in a quieter moment. Nothing is half-applied: it is one transaction.
    await client.query("set local lock_timeout = '10s'");
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0]
      ? { ...readiness.rows[0], ...(readiness.rows[0].table_ready ? (await client.query(SEED_QUERY)).rows[0] : { seed_ready: false }) }
      : undefined;
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`ORGANIZATION_PROFILES_NOT_READY: ${missing.join(', ')}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function run() {
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING?.trim();
  if (!connectionString) throw new Error('MISSING_AZURE_POSTGRES_CONNECTION_STRING');
  const target = assertDeclaredWriteTargetFromEnv(connectionString);

  const migrationPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../infra/azure/pilot_slice_postgres_organization_profiles_migration.sql',
  );
  const sql = await fs.readFile(migrationPath, 'utf8');
  const client = new Client({ connectionString, ssl: sslConfig() });
  await client.connect();
  try {
    await applyMigrationTransaction(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied organization profiles migration: ${migrationPath}`);
  console.log('PILOT ORGANIZATION PROFILES MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ORGANIZATION PROFILES MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
