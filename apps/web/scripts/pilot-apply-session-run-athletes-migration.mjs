import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the session-run-athletes migration (F-067) inside one transaction. The operator
// names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

/** The columns of constraint `c` on its own table, sorted by name. */
const KEY_COLUMNS = `(
  select array_agg(a.attname::text order by a.attname)
    from pg_attribute a
   where a.attrelid = c.conrelid and a.attnum = any (c.conkey)
)`;

// Readiness asserts the result, not the attempt. Every object is looked up by name ON its own
// table, so a same-named object elsewhere does not pass, and each check reads the thing that
// makes the rule true: the key's columns, a foreign key's target and its cascade, a check's own
// text, a column's nullability.
const READINESS_QUERY = `
  select
    to_regclass('pilot.session_run_athletes') is not null as table_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.session_run_athletes')
         and c.conname = 'pilot_session_run_athletes_pkey' and c.contype = 'p'
         and ${KEY_COLUMNS} = array['athlete_id', 'organization_id', 'run_id']
    ) as primary_key_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.session_run_athletes')
         and c.conname = 'pilot_session_run_athletes_run_fk' and c.contype = 'f'
         and c.confrelid = to_regclass('pilot.session_script_runs') and c.confdeltype = 'c'
         and ${KEY_COLUMNS} = array['organization_id', 'run_id']
    ) as run_fk_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.session_run_athletes')
         and c.conname = 'pilot_session_run_athletes_athlete_fk' and c.contype = 'f'
         and c.confrelid = to_regclass('pilot.athletes') and c.confdeltype = 'c'
         and ${KEY_COLUMNS} = array['athlete_id', 'organization_id']
    ) as athlete_fk_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.session_run_athletes')
         and c.conname = 'pilot_session_run_athletes_role_check' and c.contype = 'c' and c.convalidated
         -- Exactly the three staff roles: the quoted values in the check's own text, as a set.
         and (
           select array_agg(m[1] order by m[1])
             from regexp_matches(pg_get_constraintdef(c.oid), '''([a-z_]+)''::text', 'g') as m
         ) = array['admin', 'coach', 'organization_admin']
    ) as role_check_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.session_run_athletes')
         and c.conname = 'pilot_session_run_athletes_removed_pair' and c.contype = 'c' and c.convalidated
         and pg_get_constraintdef(c.oid) like '%removed_at IS NULL%=%removed_by_account_id IS NULL%'
    ) as removed_pair_ready,
    exists (
      select 1 from pg_attribute a
       where a.attrelid = to_regclass('pilot.session_staff_notes')
         and a.attname = 'run_id' and not a.attisdropped and not a.attnotnull
    ) as notes_run_id_ready,
    exists (
      select 1 from pg_attribute a
       where a.attrelid = to_regclass('pilot.session_staff_notes')
         and a.attname = 'session_id' and not a.attisdropped and not a.attnotnull
    ) as notes_session_id_nullable,
    exists (
      -- Exactly one of the two, read from the check's own text.
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.session_staff_notes')
         and c.conname = 'pilot_session_staff_notes_one_subject' and c.contype = 'c' and c.convalidated
         and pg_get_constraintdef(c.oid) = 'CHECK ((num_nonnulls(session_id, run_id) = 1))'
    ) as notes_one_subject_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.session_staff_notes')
         and c.conname = 'pilot_session_staff_notes_run_athlete_fk' and c.contype = 'f'
         and c.confrelid = to_regclass('pilot.session_run_athletes') and c.confdeltype = 'c'
         and ${KEY_COLUMNS} = array['athlete_id', 'organization_id', 'run_id']
    ) as notes_run_athlete_fk_ready,
    exists (
      select 1 from pg_indexes
       where schemaname = 'pilot' and tablename = 'session_staff_notes'
         and indexname = 'idx_session_staff_notes_run'
         and indexdef like '%(organization_id, run_id, created_at) WHERE ((deleted_at IS NULL) AND (run_id IS NOT NULL))'
    ) as notes_run_index_ready
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`SESSION_RUN_ATHLETES_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_session_run_athletes_migration.sql',
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
  console.log(`Applied session run athletes migration: ${migrationPath}`);
  console.log('PILOT SESSION RUN ATHLETES MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SESSION RUN ATHLETES MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
