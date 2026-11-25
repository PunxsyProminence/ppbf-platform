import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the email-alert-switches migration (lane W4-1, EM-1; each person's
// opt-in switch for the content-free email alert, OD-2026-11-19-019, OW27-10 A)
// inside one transaction. The operator names the host and database they
// believe they are pointing at (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE);
// a mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Asserts the table, its exact column list, switched_on NOT NULL with default
// false (every switch starts off, OD-2026-11-19-019), exactly the CHECKs below
// and no others, each compared IN FULL against the text Postgres stores
// (emailAlertSwitchesMigration.pg.test.ts drives this runner against a real
// database, so a deparse mismatch fails there first), the two-column primary
// key in order, both foreign keys by column, target and delete rule (both
// cascade), and the partial index the sender reads through, by its full
// definition.
export const EXPECTED_CHECKS = {
  pilot_email_alert_switch_user_type_check:
    "CHECK ((user_type = ANY (ARRAY['staff'::text, 'parent'::text, 'adult_athlete'::text])))",
  pilot_email_alert_switch_athlete_confirmed_check:
    "CHECK (((user_type <> 'adult_athlete'::text) OR (NOT switched_on) OR (confirmed_address IS NOT NULL)))",
  pilot_email_alert_switch_address_athlete_only_check:
    "CHECK (((user_type = 'adult_athlete'::text) OR ((pending_address IS NULL) AND (pending_code_hash IS NULL) AND (confirmed_address IS NULL))))",
  pilot_email_alert_switch_on_time_check:
    'CHECK (((NOT switched_on) OR (switched_on_at IS NOT NULL)))',
  pilot_email_alert_switch_code_pair_check:
    'CHECK (((pending_code_hash IS NULL) = (pending_code_expires_at IS NULL)))',
  pilot_email_alert_switch_confirmed_pair_check:
    'CHECK (((confirmed_address IS NULL) = (confirmed_at IS NULL)))',
  pilot_email_alert_switch_attempts_check:
    'CHECK ((pending_code_attempts >= 0))',
  pilot_email_alert_switch_code_needs_address_check:
    'CHECK (((pending_code_hash IS NULL) OR (pending_address IS NOT NULL)))',
};

export const EXPECTED_INDEX_DEF =
  'CREATE INDEX idx_email_alert_switches_on ON pilot.email_alert_switches USING btree (organization_id, account_id) WHERE switched_on';

export const EXPECTED_COLUMNS = [
  'organization_id',
  'account_id',
  'user_type',
  'switched_on',
  'switched_on_at',
  'switched_off_at',
  'set_at',
  'pending_address',
  'pending_code_hash',
  'pending_code_expires_at',
  'pending_code_attempts',
  'confirmed_address',
  'confirmed_at',
];

const TABLE = `to_regclass('pilot.email_alert_switches')`;

function foreignKeyReady(column, target) {
  return `exists (
      select 1 from pg_constraint c
      where c.conrelid = ${TABLE} and c.contype = 'f'
        and c.convalidated and c.confrelid = to_regclass('${target}') and c.confdeltype = 'c'
        and (select array_agg(a.attname::text)
               from unnest(c.conkey) k(attnum)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
            = array['${column}']
    )`;
}

const READINESS_QUERY = `
  select
    ${TABLE} is not null as table_ready,
    (
      select array_agg(column_name::text order by ordinal_position)
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'email_alert_switches'
    ) = $4::text[] as columns_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'email_alert_switches'
        and column_name = 'switched_on' and is_nullable = 'NO' and column_default = 'false'
    ) as switched_on_starts_off,
    (
      select count(*) = $1 from pg_constraint c
      join unnest($2::text[], $3::text[]) as expected(conname, condef) on expected.conname = c.conname
      where c.conrelid = ${TABLE}
        and c.contype = 'c' and c.convalidated
        and pg_get_constraintdef(c.oid) = expected.condef
    ) as checks_ready,
    (
      select count(*) = $1 from pg_constraint c
      where c.conrelid = ${TABLE} and c.contype = 'c'
    ) as no_other_checks,
    exists (
      select 1 from pg_constraint c
      where c.conrelid = ${TABLE} and c.contype = 'p'
        and (select array_agg(a.attname::text order by k.ord)
               from unnest(c.conkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
            = array['organization_id', 'account_id']
    ) as primary_key_ready,
    ${foreignKeyReady('organization_id', 'pilot.organizations')} as organization_fk_ready,
    ${foreignKeyReady('account_id', 'pilot.accounts')} as account_fk_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot' and tablename = 'email_alert_switches'
        and indexname = 'idx_email_alert_switches_on'
        and indexdef = $5
    ) as on_index_ready
`;
const READINESS_PARAMS = [
  Object.keys(EXPECTED_CHECKS).length,
  Object.keys(EXPECTED_CHECKS),
  Object.values(EXPECTED_CHECKS),
  EXPECTED_COLUMNS,
  EXPECTED_INDEX_DEF,
];

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY, READINESS_PARAMS);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error('EMAIL_ALERT_SWITCHES_TABLE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_email_alert_switches_migration.sql',
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
  console.log(`Applied email alert switches migration: ${migrationPath}`);
  console.log('PILOT EMAIL ALERT SWITCHES MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT EMAIL ALERT SWITCHES MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
