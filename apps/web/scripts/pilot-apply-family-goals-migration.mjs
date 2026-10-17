import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the family-goals migration (PH-05, issue #1593) inside one transaction. The operator
// names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Readiness asserts the result, not the attempt: the table, its primary key over (gym, goal),
// its athlete foreign key over (gym, athlete) with the cascade, both writer foreign keys with
// set null, every named check, the per-child index, and the guard trigger. Each is looked up by name ON its own
// table, so a same-named object elsewhere does not pass.
const READINESS_QUERY = `
  select
    to_regclass('pilot.family_goals') is not null as table_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.family_goals')
         and c.conname = 'pilot_family_goals_pkey' and c.contype = 'p'
         and (
           select array_agg(a.attname::text order by a.attname)
             from pg_attribute a
            where a.attrelid = c.conrelid and a.attnum = any (c.conkey)
         ) = array['goal_id', 'organization_id']
    ) as primary_key_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.family_goals')
         and c.conname = 'pilot_family_goals_athlete_fk' and c.contype = 'f'
         and c.confrelid = to_regclass('pilot.athletes')
         and c.confdeltype = 'c'
         and (
           select array_agg(a.attname::text order by a.attname)
             from pg_attribute a
            where a.attrelid = c.conrelid and a.attnum = any (c.conkey)
         ) = array['athlete_id', 'organization_id']
    ) as athlete_fk_ready,
    (
      -- Exactly created_by_account_id and updated_by_account_id -> accounts.account_id, set null.
      select count(*) from pg_constraint c
       where c.conrelid = to_regclass('pilot.family_goals')
         and c.contype = 'f' and c.confrelid = to_regclass('pilot.accounts')
         and c.confdeltype = 'n'
         and array_length(c.conkey, 1) = 1 and array_length(c.confkey, 1) = 1
         and (select a.attname from pg_attribute a where a.attrelid = c.conrelid and a.attnum = c.conkey[1])
             in ('created_by_account_id', 'updated_by_account_id')
         and (select a.attname from pg_attribute a where a.attrelid = c.confrelid and a.attnum = c.confkey[1]) = 'account_id'
    ) = 2 as writer_fks_set_null,
    (
      -- Each check by name AND by what it says (key fragments of pg_get_constraintdef, as the
      -- achievements runner does): a same-named CHECK (true) left by an earlier table must not
      -- pass for the real one.
      select count(*) from pg_constraint c,
             lateral (select pg_get_constraintdef(c.oid) as def) d
       where c.conrelid = to_regclass('pilot.family_goals')
         and c.contype = 'c' and c.convalidated
         and (
           (c.conname = 'pilot_family_goals_title_check'
             and d.def like '%char_length(btrim(title))%' and d.def like '%1%' and d.def like '%200%')
           or (c.conname = 'pilot_family_goals_support_action_check'
             and d.def like '%char_length(btrim(support_action))%' and d.def like '%500%')
           or (c.conname = 'pilot_family_goals_state_check'
             and d.def like '%''active''%' and d.def like '%''completed''%')
           or (c.conname = 'pilot_family_goals_completed_check'
             and d.def like '%''completed''%' and d.def like '%completed_at IS NOT NULL%')
           -- The writer roles exactly (Q-E): every quoted word in the check, and nothing more, so a
           -- same-named check left by an earlier table that also admits 'athlete' does not pass.
           or (c.conname in ('pilot_family_goals_created_by_role_check', 'pilot_family_goals_updated_by_role_check')
             and (
               select array_agg(distinct m[1] order by m[1])
                 from regexp_matches(d.def, '''([a-z_]+)''', 'g') as m
             ) = array['admin', 'coach', 'organization_admin', 'parent'])
         )
    ) = 6 as checks_ready,
    exists (
      -- One child's goals newest first: exactly (gym, athlete, created_at desc), not partial.
      select 1 from pg_index i
       where i.indexrelid = to_regclass('pilot.idx_family_goals_athlete')
         and i.indrelid = to_regclass('pilot.family_goals')
         and i.indpred is null and i.indexprs is null
         and (
           select array_agg(a.attname::text order by k.ord)
             from unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
         ) = array['organization_id', 'athlete_id', 'created_at']
    ) as athlete_index_ready,
    exists (
      -- BEFORE (bit 2), ROW (bit 1), on INSERT (bit 4), DELETE (bit 8) and UPDATE (bit 16), firing in ordinary
      -- sessions (O or A; R fires only under replication, D never), and calling this
      -- migration's function.
      select 1 from pg_trigger t
       where t.tgrelid = to_regclass('pilot.family_goals')
         and t.tgname = 'trg_family_goals_guard' and not t.tgisinternal
         and t.tgenabled in ('O', 'A')
         and (t.tgtype & 2) = 2 and (t.tgtype & 1) = 1
         and (t.tgtype & 4) = 4 and (t.tgtype & 8) = 8 and (t.tgtype & 16) = 16
         and t.tgfoid = to_regprocedure('pilot.family_goals_guard()')
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
      throw new Error(`FAMILY_GOALS_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_family_goals_migration.sql',
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
  console.log(`Applied family goals migration: ${migrationPath}`);
  console.log('PILOT FAMILY GOALS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT FAMILY GOALS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
