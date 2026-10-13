import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the family-message-replies migration (FC-02) inside one transaction. The operator
// names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Readiness asserts the result, not the attempt: the table, its note foreign key with the
// cascade, the author foreign key with SET NULL (D-9), both checks, the unique index on the
// note bus the foreign key needs, and the append-only trigger. Each is looked up by name ON
// its own table, so a same-named object elsewhere does not pass for it.
const READINESS_QUERY = `
  select
    to_regclass('pilot.family_message_replies') is not null as table_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.family_message_replies')
         and c.conname = 'pilot_family_message_replies_note_fk' and c.contype = 'f'
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
       where c.conrelid = to_regclass('pilot.family_message_replies')
         and c.contype = 'f' and c.confrelid = to_regclass('pilot.accounts')
         and c.confdeltype = 'n' and a.attname = 'author_account_id'
    ) as author_fk_set_null,
    (
      select count(*) = 2 from pg_constraint
       where conrelid = to_regclass('pilot.family_message_replies')
         and contype = 'c' and convalidated
         and conname in ('pilot_family_message_replies_role_check', 'pilot_family_message_replies_text_check')
    ) as checks_ready,
    exists (
      select 1 from pg_index i
       where i.indexrelid = to_regclass('pilot.uq_pilot_coach_observations_org_note_athlete')
         and i.indrelid = to_regclass('pilot.coach_observations')
         and i.indisunique
    ) as note_index_ready,
    exists (
      -- BEFORE (bit 2), ROW (bit 1), on INSERT (bit 4) and UPDATE (bit 16), enabled, and
      -- calling this migration's function.
      select 1 from pg_trigger t
       where t.tgrelid = to_regclass('pilot.family_message_replies')
         and t.tgname = 'trg_family_message_replies_guard' and not t.tgisinternal
         and t.tgenabled <> 'D'
         and (t.tgtype & 2) = 2 and (t.tgtype & 1) = 1
         and (t.tgtype & 4) = 4 and (t.tgtype & 16) = 16
         and t.tgfoid = to_regprocedure('pilot.family_message_replies_guard()')
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
      throw new Error(`FAMILY_MESSAGE_REPLIES_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_family_message_replies_migration.sql',
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
  console.log(`Applied family message replies migration: ${migrationPath}`);
  console.log('PILOT FAMILY MESSAGE REPLIES MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT FAMILY MESSAGE REPLIES MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
