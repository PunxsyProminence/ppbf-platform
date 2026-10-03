import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// The table, its key, its membership foreign key (cascading), both checks and
// the per-organization name index. The migration creates the table only if it
// is absent, so a table already there under the name is judged by this alone:
// the key, the foreign key and the index are compared to their exact
// definitions (a key with an extra column, or a name index without the
// organization, would otherwise pass), and every column's type is asked.
// to_regclass() rather than ::regclass, so an unmigrated database reports
// "not ready" instead of a SQL error.
const READINESS_QUERY = `
  select
    (
      select count(*) = 6
        from information_schema.columns
       where table_schema = 'pilot' and table_name = 'labeller_credentials'
         and is_nullable = 'NO'
         and (column_name, data_type) in (
           ('organization_id', 'text'), ('account_id', 'text'), ('display_name', 'text'), ('pin_hash', 'text'),
           ('set_at', 'timestamp with time zone'), ('updated_at', 'timestamp with time zone')
         )
    ) as columns_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.labeller_credentials') and c.contype = 'p'
         and pg_get_constraintdef(c.oid) = 'PRIMARY KEY (organization_id, account_id)'
    ) as primary_key_ready,
    exists (
      select 1 from pg_constraint c
       where c.conname = 'pilot_labeller_credentials_membership_fk'
         and c.conrelid = to_regclass('pilot.labeller_credentials')
         and c.contype = 'f' and c.convalidated
         and pg_get_constraintdef(c.oid) = 'FOREIGN KEY (account_id, organization_id) REFERENCES pilot.organization_memberships(account_id, organization_id) ON DELETE CASCADE'
    ) as membership_fk_ready,
    exists (
      select 1 from pg_constraint c
       where c.conname = 'pilot_labeller_credentials_display_name_check'
         and c.conrelid = to_regclass('pilot.labeller_credentials')
         and c.contype = 'c' and c.convalidated
    ) as display_name_check_ready,
    exists (
      select 1 from pg_constraint c
       where c.conname = 'pilot_labeller_credentials_pin_hash_check'
         and c.conrelid = to_regclass('pilot.labeller_credentials')
         and c.contype = 'c' and c.convalidated
    ) as pin_hash_check_ready,
    exists (
      select 1 from pg_indexes
       where schemaname = 'pilot' and tablename = 'labeller_credentials'
         and indexname = 'pilot_labeller_credentials_display_name_uq'
         and indexdef = 'CREATE UNIQUE INDEX pilot_labeller_credentials_display_name_uq ON pilot.labeller_credentials USING btree (organization_id, lower(display_name))'
    ) as display_name_index_ready
`;

// What the two checks DO, not what their text says: a database can hold the
// right name over the wrong rule, because the migration only adds a check
// whose name is absent. Each expression is evaluated against rows it must
// admit and rows it must refuse. Samples, not a proof.
const READINESS_PROBE = `
do $labeller_credentials_probe$
declare
  name_expr text;
  hash_expr text;
  admitted boolean;
  candidate text;
begin
  select pg_get_expr(c.conbin, c.conrelid) into name_expr from pg_constraint c
   where c.conname = 'pilot_labeller_credentials_display_name_check'
     and c.conrelid = to_regclass('pilot.labeller_credentials');
  select pg_get_expr(c.conbin, c.conrelid) into hash_expr from pg_constraint c
   where c.conname = 'pilot_labeller_credentials_pin_hash_check'
     and c.conrelid = to_regclass('pilot.labeller_credentials');

  foreach candidate in array array['Coach Mike', 'M', repeat('x', 40)]::text[] loop
    execute format('select coalesce((%s), true) from (select $1::text as display_name) probe', name_expr)
      into admitted using candidate;
    if not admitted then
      raise exception 'LABELLER_CREDENTIALS_MIGRATION_NOT_READY:display_name check refuses "%"', candidate;
    end if;
  end loop;
  foreach candidate in array array['', ' Mike', 'Mike ', repeat('x', 41)]::text[] loop
    execute format('select coalesce((%s), true) from (select $1::text as display_name) probe', name_expr)
      into admitted using candidate;
    if admitted then
      raise exception 'LABELLER_CREDENTIALS_MIGRATION_NOT_READY:display_name check admits "%"', candidate;
    end if;
  end loop;

  execute format('select coalesce((%s), true) from (select $1::text as pin_hash) probe', hash_expr)
    into admitted using 'scrypt$00ff$00ff';
  if not admitted then
    raise exception 'LABELLER_CREDENTIALS_MIGRATION_NOT_READY:pin_hash check refuses a scrypt hash';
  end if;
  foreach candidate in array array['1234', '']::text[] loop
    execute format('select coalesce((%s), true) from (select $1::text as pin_hash) probe', hash_expr)
      into admitted using candidate;
    if admitted then
      raise exception 'LABELLER_CREDENTIALS_MIGRATION_NOT_READY:pin_hash check admits "%"', candidate;
    end if;
  end loop;
end
$labeller_credentials_probe$;
`;

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// One transaction: the SQL and the readiness check commit together or not at
// all. Exported so the pg suite runs exactly this against a disposable database.
export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error(`LABELLER_CREDENTIALS_MIGRATION_NOT_READY:${JSON.stringify(row)}`);
    }
    try {
      await client.query(READINESS_PROBE);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        message.startsWith('LABELLER_CREDENTIALS_MIGRATION_NOT_READY')
          ? message
          : `LABELLER_CREDENTIALS_MIGRATION_NOT_READY:a check could not be evaluated: ${message}`,
      );
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
    '../../../infra/azure/pilot_slice_postgres_labeller_credentials_migration.sql',
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
  console.log('PILOT LABELLER CREDENTIALS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT LABELLER CREDENTIALS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
