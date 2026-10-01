import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Asks for each column and each constraint by name AND by what it says. The
// columns alone are not readiness: a database that has them without the
// checks accepts half a credential and any sign_in_method string.
//
// to_regclass() rather than the ::regclass cast, so an unmigrated database is
// reported as not ready instead of as a SQL error.
const READINESS_QUERY = `
  select
    (
      select count(*) = 2
        from information_schema.columns
       where table_schema = 'pilot' and table_name = 'accounts'
         and column_name in ('password_hash', 'password_set_at')
         and is_nullable = 'YES'
    ) as account_columns_ready,
    exists (
      select 1 from information_schema.columns
       where table_schema = 'pilot' and table_name = 'session_tokens'
         and column_name = 'sign_in_method' and is_nullable = 'YES'
    ) as session_column_ready,
    exists (
      select 1 from pg_constraint c
       where c.conname = 'pilot_accounts_password_pair_check'
         and c.conrelid = to_regclass('pilot.accounts')
         and c.contype = 'c' and c.convalidated
    ) as password_pair_check_ready,
    exists (
      select 1 from pg_constraint c
       where c.conname = 'pilot_session_tokens_sign_in_method_check'
         and c.conrelid = to_regclass('pilot.session_tokens')
         and c.contype = 'c' and c.convalidated
         and pg_get_constraintdef(c.oid) ilike '%magic_link%'
    ) as sign_in_method_check_ready
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
