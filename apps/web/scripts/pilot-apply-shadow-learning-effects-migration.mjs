import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the shadow-learning-effects migration inside one transaction.
// The operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// The exact text PostgreSQL prints for this migration's own check. Compared
// whole (whitespace-normalised), not by its quoted words, so a same-named
// check that admits more values does not pass (the #1653 Codex finding).
export const EXPECTED_EFFECTS_CHECK =
  "CHECK ((learning_effects_done <@ ARRAY['library_flag'::text, 'facts'::text, 'complete'::text]))";

// Every clause is false on a database this migration has not reached, and
// each one alone refuses, with its name in the error
// (shadowLearningEffectsMigration.pg.test.ts).
const READINESS_QUERY = `
  with effects_column as (
    select data_type, udt_name, is_nullable, column_default
      from information_schema.columns
     where table_schema = 'pilot' and table_name = 'shadow_feedback'
       and column_name = 'learning_effects_done'
  )
  select
    exists (select 1 from effects_column where data_type = 'ARRAY' and udt_name = '_text') as effects_column_text_array,
    exists (select 1 from effects_column where is_nullable = 'NO') as effects_column_not_null,
    exists (select 1 from effects_column where column_default like '''{}''::text[]%') as effects_column_default_empty,
    exists (
      select 1 from pg_constraint
      where conname = 'shadow_feedback_learning_effects_done_check'
        and conrelid = to_regclass('pilot.shadow_feedback') and contype = 'c'
        and convalidated
        and regexp_replace(pg_get_constraintdef(oid), '[[:space:]]+', ' ', 'g') = $1
    ) as effects_check_ready
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    // The first apply takes an exclusive lock on pilot.shadow_feedback for the
    // column and its backfill; wait at most this long for it rather than queue
    // every feedback read and write behind a long-open transaction.
    await client.query("set local lock_timeout = '10s'");
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY, [EXPECTED_EFFECTS_CHECK]);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`SHADOW_LEARNING_EFFECTS_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_shadow_learning_effects_migration.sql',
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
  console.log('PILOT SHADOW LEARNING EFFECTS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SHADOW LEARNING EFFECTS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
