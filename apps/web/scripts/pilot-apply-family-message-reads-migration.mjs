import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the family-message-reads migration (FC-04) inside one transaction. The operator
// names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Readiness asserts the result, not the attempt: the table, its primary key over (gym, note,
// reader), its note foreign key with the cascade, its reader foreign key with the cascade, the
// role check, the unique index on the note bus the foreign key needs, and the guard trigger.
// Each is looked up by name ON its own table, so a same-named object elsewhere does not pass.
const READINESS_QUERY = `
  select
    to_regclass('pilot.family_message_reads') is not null as table_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.family_message_reads')
         and c.conname = 'pilot_family_message_reads_pkey' and c.contype = 'p'
         and (
           select array_agg(a.attname::text order by a.attname)
             from pg_attribute a
            where a.attrelid = c.conrelid and a.attnum = any (c.conkey)
         ) = array['note_id', 'organization_id', 'reader_account_id']
    ) as primary_key_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.family_message_reads')
         and c.conname = 'pilot_family_message_reads_note_fk' and c.contype = 'f'
         and c.confrelid = to_regclass('pilot.coach_observations')
         and c.confdeltype = 'c'
         and (
           select array_agg(a.attname::text order by a.attname)
             from pg_attribute a
            where a.attrelid = c.conrelid and a.attnum = any (c.conkey)
         ) = array['athlete_id', 'note_id', 'organization_id']
    ) as note_fk_ready,
    exists (
      select 1 from pg_constraint c
       join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
       where c.conrelid = to_regclass('pilot.family_message_reads')
         and c.contype = 'f' and c.confrelid = to_regclass('pilot.accounts')
         and c.confdeltype = 'c' and a.attname = 'reader_account_id'
    ) as reader_fk_cascade,
    exists (
      select 1 from pg_constraint
       where conrelid = to_regclass('pilot.family_message_reads')
         and contype = 'c' and convalidated
         and conname = 'pilot_family_message_reads_role_check'
    ) as role_check_ready,
    exists (
      select 1 from pg_index i
       where i.indexrelid = to_regclass('pilot.uq_pilot_coach_observations_org_note_athlete')
         and i.indrelid = to_regclass('pilot.coach_observations')
         and i.indisunique
    ) as note_index_ready,
    exists (
      -- BEFORE (bit 2), ROW (bit 1), on INSERT (bit 4), DELETE (bit 8) and UPDATE (bit 16),
      -- firing in ordinary sessions (O or A; R fires only under replication, D never), and
      -- calling this migration's function.
      select 1 from pg_trigger t
       where t.tgrelid = to_regclass('pilot.family_message_reads')
         and t.tgname = 'trg_family_message_reads_guard' and not t.tgisinternal
         and t.tgenabled in ('O', 'A')
         and (t.tgtype & 2) = 2 and (t.tgtype & 1) = 1
         and (t.tgtype & 4) = 4 and (t.tgtype & 8) = 8 and (t.tgtype & 16) = 16
         and t.tgfoid = to_regprocedure('pilot.family_message_reads_guard()')
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
      throw new Error(`FAMILY_MESSAGE_READS_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_family_message_reads_migration.sql',
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
  console.log(`Applied family message reads migration: ${migrationPath}`);
  console.log('PILOT FAMILY MESSAGE READS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT FAMILY MESSAGE READS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
