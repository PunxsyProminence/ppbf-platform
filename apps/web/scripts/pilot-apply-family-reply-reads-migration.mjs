import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the family-reply-reads migration (FC-09) inside one transaction. The operator
// names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Readiness asserts the result, not the attempt: the table, its primary key over (gym, reply,
// reader), its reply foreign key with the cascade, its reader foreign key with the cascade, the
// role check over exactly the three staff roles, and the guard trigger. Each is looked up by name
// ON its own table, so a same-named object elsewhere does not pass.
const READINESS_QUERY = `
  select
    to_regclass('pilot.family_reply_reads') is not null as table_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.family_reply_reads')
         and c.conname = 'pilot_family_reply_reads_pkey' and c.contype = 'p'
         and (
           select array_agg(a.attname::text order by a.attname)
             from pg_attribute a
            where a.attrelid = c.conrelid and a.attnum = any (c.conkey)
         ) = array['organization_id', 'reader_account_id', 'reply_id']
    ) as primary_key_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.family_reply_reads')
         and c.conname = 'pilot_family_reply_reads_reply_fk' and c.contype = 'f'
         and c.confrelid = to_regclass('pilot.family_message_replies')
         and c.confdeltype = 'c'
         and (
           select array_agg(a.attname::text order by a.attname)
             from pg_attribute a
            where a.attrelid = c.conrelid and a.attnum = any (c.conkey)
         ) = array['organization_id', 'reply_id']
    ) as reply_fk_ready,
    exists (
      -- Exactly reader_account_id -> accounts.account_id, one column each side.
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.family_reply_reads')
         and c.contype = 'f' and c.confrelid = to_regclass('pilot.accounts')
         and c.confdeltype = 'c'
         and array_length(c.conkey, 1) = 1 and array_length(c.confkey, 1) = 1
         and (select a.attname from pg_attribute a where a.attrelid = c.conrelid and a.attnum = c.conkey[1]) = 'reader_account_id'
         and (select a.attname from pg_attribute a where a.attrelid = c.confrelid and a.attnum = c.confkey[1]) = 'account_id'
    ) as reader_fk_cascade,
    exists (
      -- The check by name, and over exactly the three staff roles (every quoted word in it, and
      -- nothing more): a pre-existing table whose check of that name admits 'parent' does not pass.
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.family_reply_reads')
         and c.contype = 'c' and c.convalidated
         and c.conname = 'pilot_family_reply_reads_role_check'
         and (
           select array_agg(distinct m[1] order by m[1])
             from regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''', 'g') as m
         ) = array['admin', 'coach', 'organization_admin']
    ) as role_check_ready,
    exists (
      -- BEFORE (bit 2), ROW (bit 1), on INSERT (bit 4), DELETE (bit 8) and UPDATE (bit 16),
      -- firing in ordinary sessions (O or A; R fires only under replication, D never), and
      -- calling this migration's function.
      select 1 from pg_trigger t
       where t.tgrelid = to_regclass('pilot.family_reply_reads')
         and t.tgname = 'trg_family_reply_reads_guard' and not t.tgisinternal
         and t.tgenabled in ('O', 'A')
         and (t.tgtype & 2) = 2 and (t.tgtype & 1) = 1
         and (t.tgtype & 4) = 4 and (t.tgtype & 8) = 8 and (t.tgtype & 16) = 16
         and t.tgfoid = to_regprocedure('pilot.family_reply_reads_guard()')
    ) as guard_ready
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`FAMILY_REPLY_READS_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_family_reply_reads_migration.sql',
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
  console.log(`Applied family reply reads migration: ${migrationPath}`);
  console.log('PILOT FAMILY REPLY READS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT FAMILY REPLY READS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
