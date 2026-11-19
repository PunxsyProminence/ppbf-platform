import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the organization-tablet-idle-policy migration (lane U1, AS2-a;
// OW25-53 A: the gym admin sets the gym tablet's idle sign-out time) inside
// one transaction. The operator names the host and database they believe
// they are pointing at (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a
// mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Asserts the table, its exact column list, the one CHECK compared IN FULL
// against the text Postgres stores (tabletIdlePolicy.pg.test.ts drives this
// runner against a real database, so a deparse mismatch fails there first),
// the primary key, and both foreign keys by column, target and delete rule.
const EXPECTED_CHECKS = {
  pilot_org_tablet_idle_minutes_check:
    'CHECK ((idle_minutes = ANY (ARRAY[15, 30, 60, 120, 240])))',
};

export const EXPECTED_COLUMNS = [
  'organization_id',
  'idle_minutes',
  'set_by_account_id',
  'set_at',
];

const READINESS_QUERY = `
  select
    to_regclass('pilot.organization_tablet_idle_policy') is not null as table_ready,
    (
      select array_agg(column_name::text order by ordinal_position)
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'organization_tablet_idle_policy'
    ) = $4::text[] as columns_ready,
    (
      select count(*) = $1 from pg_constraint c
      join unnest($2::text[], $3::text[]) as expected(conname, condef) on expected.conname = c.conname
      where c.conrelid = to_regclass('pilot.organization_tablet_idle_policy')
        and c.contype = 'c' and c.convalidated
        and pg_get_constraintdef(c.oid) = expected.condef
    ) as checks_ready,
    exists (
      select 1 from pg_constraint c
      where c.conrelid = to_regclass('pilot.organization_tablet_idle_policy') and c.contype = 'p'
        and (select array_agg(a.attname::text)
               from unnest(c.conkey) k(attnum)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
            = array['organization_id']
    ) as primary_key_ready,
    exists (
      select 1 from pg_constraint c
      where c.conrelid = to_regclass('pilot.organization_tablet_idle_policy') and c.contype = 'f'
        and c.convalidated and c.confrelid = to_regclass('pilot.organizations') and c.confdeltype = 'c'
        and (select array_agg(a.attname::text)
               from unnest(c.conkey) k(attnum)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
            = array['organization_id']
    ) as organization_fk_ready,
    exists (
      select 1 from pg_constraint c
      where c.conrelid = to_regclass('pilot.organization_tablet_idle_policy') and c.contype = 'f'
        and c.convalidated and c.confrelid = to_regclass('pilot.accounts') and c.confdeltype = 'n'
        and (select array_agg(a.attname::text)
               from unnest(c.conkey) k(attnum)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
            = array['set_by_account_id']
    ) as set_by_fk_ready
`;
const READINESS_PARAMS = [
  Object.keys(EXPECTED_CHECKS).length,
  Object.keys(EXPECTED_CHECKS),
  Object.values(EXPECTED_CHECKS),
  EXPECTED_COLUMNS,
];

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY, READINESS_PARAMS);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error('ORGANIZATION_TABLET_IDLE_POLICY_TABLE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_organization_tablet_idle_policy_migration.sql',
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
  console.log(`Applied organization tablet idle policy migration: ${migrationPath}`);
  console.log('PILOT ORGANIZATION TABLET IDLE POLICY MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ORGANIZATION TABLET IDLE POLICY MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
