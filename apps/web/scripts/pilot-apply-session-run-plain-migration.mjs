import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the session-run-plain migration (issue #1523) inside one transaction. The operator
// names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Readiness asserts the result, not the attempt: both columns nullable, and each check ON
// pilot.session_script_runs (looked up by conrelid) with exactly the definition this migration
// writes -- so a stricter cursor check left behind by an older file, or a missing pair check,
// refuses the commit rather than passing on a name.
export const EXPECTED_CHECKS = [
  ['pilot_ssrun_script_pair', 'CHECK (((script_id IS NULL) = (script_version IS NULL)))'],
  ['pilot_ssrun_plain_has_state', 'CHECK (((script_id IS NOT NULL) OR (run_state IS NOT NULL)))'],
  ['pilot_ssrun_plain_no_cursor', 'CHECK (((script_id IS NOT NULL) OR (current_block_id IS NULL)))'],
  ['pilot_ssrun_cursor_matches_state',
    "CHECK (((run_state IS NULL) OR ((run_state = 'in_progress'::text) AND ((current_block_id IS NOT NULL) OR (script_id IS NULL))) OR ((run_state = ANY (ARRAY['completed'::text, 'abandoned'::text])) AND (current_block_id IS NULL))))"],
];

const READINESS_QUERY = `
  select
    to_regclass('pilot.session_script_runs') is not null as runs_table_ready,
    (
      select count(*) = 2 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'session_script_runs'
        and column_name in ('script_id', 'script_version')
        and is_nullable = 'YES'
    ) as script_columns_nullable,
    (
      select count(*) = $1 from pg_constraint c
      join unnest($2::text[], $3::text[]) as expected(conname, condef)
        on expected.conname = c.conname
      where c.conrelid = to_regclass('pilot.session_script_runs')
        and c.contype = 'c' and c.convalidated
        and pg_get_constraintdef(c.oid) = expected.condef
    ) as checks_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.session_script_runs')
        and conname = 'pilot_ssrun_script_fk' and contype = 'f'
    ) as script_fk_kept
`;
const READINESS_PARAMS = [
  EXPECTED_CHECKS.length,
  EXPECTED_CHECKS.map((check) => check[0]),
  EXPECTED_CHECKS.map((check) => check[1]),
];

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY, READINESS_PARAMS);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error('SESSION_RUN_PLAIN_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_session_run_plain_migration.sql',
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
  console.log(`Applied session run plain migration: ${migrationPath}`);
  console.log('PILOT SESSION RUN PLAIN MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SESSION RUN PLAIN MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
