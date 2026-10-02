import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Asks for each column and for each constraint by name. The columns alone are
// not readiness: a database that has them without the checks accepts half a
// credential and any sign_in_method string. What the checks DO is asked by
// READINESS_PROBE below; the text matches here only catch a missing or
// plainly unrelated constraint with a readable field name.
//
// to_regclass() rather than the ::regclass cast, so an unmigrated database is
// reported as not ready instead of as a SQL error.
const READINESS_QUERY = `
  select
    (
      select count(*) = 2
        from information_schema.columns
       where table_schema = 'pilot' and table_name = 'accounts'
         and is_nullable = 'YES'
         and (column_name, data_type) in (('password_hash', 'text'), ('password_set_at', 'timestamp with time zone'))
    ) as account_columns_ready,
    exists (
      select 1 from information_schema.columns
       where table_schema = 'pilot' and table_name = 'session_tokens'
         and column_name = 'sign_in_method' and is_nullable = 'YES' and data_type = 'text'
    ) as session_column_ready,
    exists (
      select 1 from pg_constraint c
       where c.conname = 'pilot_accounts_password_pair_check'
         and c.conrelid = to_regclass('pilot.accounts')
         and c.contype = 'c' and c.convalidated
         and pg_get_constraintdef(c.oid) ilike '%password_hash%'
         and pg_get_constraintdef(c.oid) ilike '%password_set_at%'
    ) as password_pair_check_ready,
    exists (
      select 1 from pg_constraint c
       where c.conname = 'pilot_session_tokens_sign_in_method_check'
         and c.conrelid = to_regclass('pilot.session_tokens')
         and c.contype = 'c' and c.convalidated
         and pg_get_constraintdef(c.oid) ilike '%magic_link%'
    ) as sign_in_method_check_ready
`;

// What each check DOES, not what its text contains. The migration adds a check
// only when no constraint of that name exists, so a database can arrive here
// holding the right name over the wrong rule -- and a text match is satisfied
// by any definition that happens to mention the right words. So each check's
// own expression is evaluated against the cases it must accept and the cases
// it must refuse. A check passes a row when its expression is true or null.
//
// WHAT THIS ESTABLISHES, AND NO MORE. It samples. The four doors and null are
// all tried; "anything else" is three wrong values, and both-or-neither is
// tried with two hash values. A hand-made rule that happens to agree on every
// sample would pass. It also asks only about the two NAMED checks: a second
// check under another name, or a trigger, is not looked at.
const READINESS_PROBE = `
do $parent_password_probe$
declare
  method_expr text;
  pair_expr text;
  admitted boolean;
  candidate text;
  hash_value text;
begin
  select pg_get_expr(c.conbin, c.conrelid) into method_expr from pg_constraint c
   where c.conname = 'pilot_session_tokens_sign_in_method_check'
     and c.conrelid = to_regclass('pilot.session_tokens');
  select pg_get_expr(c.conbin, c.conrelid) into pair_expr from pg_constraint c
   where c.conname = 'pilot_accounts_password_pair_check'
     and c.conrelid = to_regclass('pilot.accounts');

  -- Every door, and "not recorded", must be admitted.
  foreach candidate in array array['magic_link', 'password', 'pin', 'microsoft', null]::text[] loop
    execute format('select coalesce((%s), true) from (select $1::text as sign_in_method) probe', method_expr)
      into admitted using candidate;
    if not admitted then
      raise exception 'PARENT_PASSWORD_MIGRATION_NOT_READY:sign_in_method check refuses %', coalesce(candidate, 'null');
    end if;
  end loop;

  -- Anything else must be refused.
  foreach candidate in array array['emailed', 'MAGIC_LINK', '']::text[] loop
    execute format('select coalesce((%s), true) from (select $1::text as sign_in_method) probe', method_expr)
      into admitted using candidate;
    if admitted then
      raise exception 'PARENT_PASSWORD_MIGRATION_NOT_READY:sign_in_method check admits "%"', candidate;
    end if;
  end loop;

  -- Both or neither: the four cases of (hash set?, timestamp set?), each with
  -- the answer the check must give, and each with two different hash values
  -- so a rule about what the hash SAYS does not pass as a rule about whether
  -- it is there.
  foreach candidate in array array['00:admit', '11:admit', '10:refuse', '01:refuse']::text[] loop
    foreach hash_value in array array['h', 'scrypt$32768$8$1$00ff$00ff']::text[] loop
      execute format(
        'select coalesce((%s), true)
           from (select case when $1 then $3 end::text as password_hash,
                        case when $2 then now() end::timestamptz as password_set_at) probe',
        pair_expr
      ) into admitted using substr(candidate, 1, 1) = '1', substr(candidate, 2, 1) = '1', hash_value;
      if admitted <> (split_part(candidate, ':', 2) = 'admit') then
        raise exception 'PARENT_PASSWORD_MIGRATION_NOT_READY:password pair check is not both-or-neither (case %)', candidate;
      end if;
    end loop;
  end loop;
end
$parent_password_probe$;
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
      throw new Error(`PARENT_PASSWORD_MIGRATION_NOT_READY:${JSON.stringify(row)}`);
    }
    try {
      await client.query(READINESS_PROBE);
    } catch (error) {
      // A check that cannot even be evaluated against the probe (it names a
      // column the probe does not supply) is the wrong check. Say so under
      // the same token as every other not-ready outcome.
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        message.startsWith('PARENT_PASSWORD_MIGRATION_NOT_READY')
          ? message
          : `PARENT_PASSWORD_MIGRATION_NOT_READY:a check could not be evaluated: ${message}`,
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
    '../../../infra/azure/pilot_slice_postgres_parent_password_migration.sql',
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
  console.log('PILOT PARENT PASSWORD MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT PARENT PASSWORD MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
