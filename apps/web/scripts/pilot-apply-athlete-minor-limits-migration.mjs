import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the athlete-minor-limits migration inside one transaction. The
// operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Asserts the table, its read index and every guard ON THIS TABLE (looked up
// by conrelid, not by name alone), so an environment where the table exists
// without one of its checks or its athlete foreign key cannot pass readiness.
// The shape check is compared in full: a looser predicate that happens to
// contain the right words fails.
const READINESS_QUERY = `
  select
    to_regclass('pilot.athlete_minor_limits') is not null as athlete_minor_limits_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot' and tablename = 'athlete_minor_limits'
        and indexname = 'idx_athlete_minor_limits_athlete_type_seq'
        and indexdef like '%(organization_id, athlete_id, limit_type, limit_seq DESC)'
    ) as athlete_type_seq_index_ready,
    (
      select count(*) = 8 from pg_constraint
      where conrelid = to_regclass('pilot.athlete_minor_limits')
        and convalidated
        and conname in (
          'pilot_athlete_minor_limits_type_check',
          'pilot_athlete_minor_limits_number_check',
          'pilot_athlete_minor_limits_text_check',
          'pilot_athlete_minor_limits_unit_check',
          'pilot_athlete_minor_limits_note_check',
          'pilot_athlete_minor_limits_role_check',
          'pilot_athlete_minor_limits_athlete_fk',
          'pilot_athlete_minor_limits_shape_check'
        )
    ) as guards_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.athlete_minor_limits')
        and conname = 'pilot_athlete_minor_limits_shape_check' and contype = 'c'
        and pg_get_constraintdef(oid) like '%heat_exposure_minutes_per_session%'
        and pg_get_constraintdef(oid) like '%weight_cut_max_percent_body_weight%'
        and pg_get_constraintdef(oid) like '%value_number <= (100)%'
        and pg_get_constraintdef(oid) like '%supervision%'
    ) as shape_check_ready,
    exists (
      select 1 from pg_constraint c
      where c.conname = 'pilot_athlete_minor_limits_athlete_fk'
        and c.conrelid = to_regclass('pilot.athlete_minor_limits') and c.contype = 'f'
        and c.confrelid = to_regclass('pilot.athletes') and c.confdeltype = 'c'
    ) as athlete_fk_ready
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error('ATHLETE_MINOR_LIMITS_TABLE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_athlete_minor_limits_migration.sql',
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
  console.log(`Applied athlete minor limits migration: ${migrationPath}`);
  console.log('PILOT ATHLETE MINOR LIMITS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ATHLETE MINOR LIMITS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
