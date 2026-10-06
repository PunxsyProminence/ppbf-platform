import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the microsoft-identity-binding migration (CL-A19) inside one
// transaction. The operator names the host and database they believe they are
// pointing at (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch
// refuses before connecting.

// The postcondition, not the statements: both columns are nullable text, the
// pair check exists and is validated, and the index is UNIQUE, PARTIAL and on
// (microsoft_tid, microsoft_oid). A non-unique index of the right name would
// let two accounts bind one directory user. to_regclass() so an unmigrated
// database reads as not ready rather than raising.
//
// audit_vocabulary_ready is the release-order guard. The refusal this change
// records ('microsoft_identity_mismatch') is admitted by the constraint that
// audit-event-vocabulary rewrites, not by this file. Applied without it, every
// refusal's audit insert dies on 23514 and the route swallows it, so the record
// silently never exists. Refusing here makes the order executable: run
// pilot:apply-audit-event-vocabulary first, then this. It reads the constraint
// by its name, audit_events_event_type_check; a vocabulary widened later under
// another name must update this check too.
export const READINESS_QUERY = `
  select
    (
      select count(*) = 2
        from information_schema.columns
       where table_schema = 'pilot' and table_name = 'accounts'
         and is_nullable = 'YES' and data_type = 'text'
         and column_name in ('microsoft_oid', 'microsoft_tid')
    ) as columns_ready,
    exists (
      select 1 from pg_constraint c
       where c.conname = 'pilot_accounts_microsoft_identity_pair_check'
         and c.conrelid = to_regclass('pilot.accounts')
         and c.contype = 'c' and c.convalidated
         and pg_get_constraintdef(c.oid) ilike '%microsoft_oid%'
         and pg_get_constraintdef(c.oid) ilike '%microsoft_tid%'
    ) as pair_check_ready,
    exists (
      select 1 from pg_index i
       where i.indexrelid = to_regclass('pilot.pilot_accounts_microsoft_identity_uq')
         and i.indrelid = to_regclass('pilot.accounts')
         and i.indisunique and i.indisvalid
         and i.indpred is not null
         and pg_get_indexdef(i.indexrelid) ilike '%(microsoft_tid, microsoft_oid) WHERE (microsoft_oid IS NOT NULL)%'
    ) as unique_index_ready,
    exists (
      select 1 from pg_constraint c
       where c.conname = 'audit_events_event_type_check'
         and c.conrelid = to_regclass('pilot.audit_events')
         and c.contype = 'c' and c.convalidated
         and pg_get_constraintdef(c.oid) like '%''microsoft_identity_mismatch''%'
    ) as audit_vocabulary_ready
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
    const row = (await client.query(READINESS_QUERY)).rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error(`MICROSOFT_IDENTITY_BINDING_NOT_READY:${JSON.stringify(row)}`);
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
    '../../../infra/azure/pilot_slice_postgres_microsoft_identity_binding_migration.sql',
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
  console.log('PILOT MICROSOFT IDENTITY BINDING MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT MICROSOFT IDENTITY BINDING MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
