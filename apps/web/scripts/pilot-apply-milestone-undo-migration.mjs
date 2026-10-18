import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the milestone-undo migration (lane L43, F-133; OD-2026-10-17-003) inside one
// transaction. The operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Readiness asserts the result, not the attempt:
//
// `undone_at_ready` -- the column, as a nullable timestamptz with no default. A NOT NULL column,
// or a default, would make every new award an undone one (hidden the moment it is made); a text or
// date column would lose the instant the undo is ordered by.
//
// `awarded_by_role_not_null` -- the check below passes when its expression is NULL, so it only
// keeps a coach's award from being undone while awarded_by_role can never be null.
//
// `undo_self_only_ready` -- the check by name ON this table, validated, and its whole predicate
// exactly as PostgreSQL prints this migration's own check (runs of whitespace collapsed). Matching
// only the quoted 'self' would pass a same-named check widened to "or awarded_by_role = 'coach'",
// which is the one thing the ruling forbids: "never touches a coach's mark".
//
// `one_award_per_milestone` -- the primary key still spans exactly (organization_id, athlete_id,
// milestone_key). An undo is a state of the one row, never a second row; a key widened to admit
// several rows per milestone would be the first per-athlete count this table could rank.
const READINESS_QUERY = `
  select
    exists (
      select 1 from information_schema.columns
       where table_schema = 'pilot' and table_name = 'athlete_milestones'
         and column_name = 'undone_at'
         and data_type = 'timestamp with time zone'
         and is_nullable = 'YES'
         and column_default is null
    ) as undone_at_ready,
    exists (
      select 1 from information_schema.columns
       where table_schema = 'pilot' and table_name = 'athlete_milestones'
         and column_name = 'awarded_by_role'
         and is_nullable = 'NO'
    ) as awarded_by_role_not_null,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.athlete_milestones')
         and c.contype = 'c' and c.convalidated
         and c.conname = 'pilot_athlete_milestones_undo_self_only'
         and regexp_replace(pg_get_constraintdef(c.oid), '[[:space:]]+', ' ', 'g')
           = 'CHECK (((undone_at IS NULL) OR (awarded_by_role = ''self''::text)))'
    ) as undo_self_only_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.athlete_milestones')
         and c.conname = 'pilot_athlete_milestones_pkey' and c.contype = 'p'
         and (
           select array_agg(a.attname::text order by a.attname)
             from pg_attribute a
            where a.attrelid = c.conrelid and a.attnum = any (c.conkey)
         ) = array['athlete_id', 'milestone_key', 'organization_id']
    ) as one_award_per_milestone
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`MILESTONE_UNDO_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_milestone_undo_migration.sql',
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
  console.log(`Applied milestone undo migration: ${migrationPath}`);
  console.log('PILOT MILESTONE UNDO MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT MILESTONE UNDO MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
