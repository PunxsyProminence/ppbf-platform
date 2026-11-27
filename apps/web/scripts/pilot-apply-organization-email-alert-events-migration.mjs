import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the organization-email-alert-events migration (lane W4-1, EM-5; the
// gym's choice of which events send the email alert, per user type, OW27-10 A;
// no row = ticked, OW27-39 A) inside one transaction. The operator names the
// host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Asserts the table, its exact column list with each column's type and
// nullability, its defaults exactly: set_at's clock_timestamp() (an insert may
// leave set_at out; Codex on #2180) and none on any other column, so ticked
// has none (every row is a choice somebody made); exactly the CHECKs below and
// no others, each compared IN FULL against the text Postgres stores
// (organizationEmailAlertEventsMigration.pg.test.ts drives this runner against
// a real database), the three-column primary key in order, and exactly two
// foreign keys: the gym key (cascade) and the setter key (set null), each by
// column, target and delete rule.
export const EXPECTED_CHECKS = {
  pilot_org_email_alert_event_user_type_check:
    "CHECK ((user_type = ANY (ARRAY['staff'::text, 'parent'::text, 'adult_athlete'::text])))",
  pilot_org_email_alert_event_kind_check:
    "CHECK ((event_kind ~ '^[a-z][a-z_]{0,62}$'::text))",
};

// name:type:nullable, in column order.
export const EXPECTED_COLUMNS = [
  'organization_id:text:NO',
  'user_type:text:NO',
  'event_kind:text:NO',
  'ticked:boolean:NO',
  'set_by_account_id:text:YES',
  'set_at:timestamp with time zone:NO',
];

const TABLE = `to_regclass('pilot.organization_email_alert_events')`;

function foreignKeyReady(column, target, deleteRule) {
  return `exists (
      select 1 from pg_constraint c
      where c.conrelid = ${TABLE} and c.contype = 'f'
        and c.convalidated and c.confrelid = to_regclass('${target}') and c.confdeltype = '${deleteRule}'
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
      select array_agg(column_name::text || ':' || data_type::text || ':' || is_nullable::text order by ordinal_position)
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'organization_email_alert_events'
    ) = $4::text[] as columns_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'organization_email_alert_events'
        and column_name = 'ticked' and is_nullable = 'NO' and column_default is null
    ) as ticked_is_a_choice,
    (
      select coalesce(array_agg(column_name::text || '=' || column_default::text order by ordinal_position), '{}')
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'organization_email_alert_events'
        and column_default is not null
    ) = array['set_at=clock_timestamp()'] as defaults_ready,
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
            = array['organization_id', 'user_type', 'event_kind']
    ) as primary_key_ready,
    ${foreignKeyReady('organization_id', 'pilot.organizations', 'c')} as organization_fk_ready,
    ${foreignKeyReady('set_by_account_id', 'pilot.accounts', 'n')} as set_by_fk_ready,
    (
      select count(*) = 2 from pg_constraint c
      where c.conrelid = ${TABLE} and c.contype = 'f'
    ) as no_other_keys
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
      throw new Error('ORGANIZATION_EMAIL_ALERT_EVENTS_TABLE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_organization_email_alert_events_migration.sql',
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
  console.log(`Applied organization email alert events migration: ${migrationPath}`);
  console.log('PILOT ORGANIZATION EMAIL ALERT EVENTS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ORGANIZATION EMAIL ALERT EVENTS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
