import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the sparring-exposure-session-date migration inside one transaction.
// The operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Every clause is false on a database this migration has not reached
// (sparringExposureSessionDate.pg.test.ts, "refuses a database the migration
// has not reached"). The foreign key to pilot.activity_log is checked too: the
// migration promises to KEEP it, so its loss is a failed migration, not a
// quieter schema.
const READINESS_QUERY = `
  select
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'sparring_exposure'
        and column_name = 'activity_id' and is_nullable = 'YES'
    ) as activity_id_nullable,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'sparring_exposure'
        and column_name = 'session_date' and data_type = 'date'
    ) as session_date_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_sparring_exposure_session_date_or_activity'
        and conrelid = to_regclass('pilot.sparring_exposure') and contype = 'c'
        and convalidated
    ) as session_date_or_activity_ready,
    exists (
      select 1 from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where c.relname = 'pilot_sparring_exposure_session_segment_uq'
        and i.indrelid = to_regclass('pilot.sparring_exposure')
        and i.indisunique and i.indisvalid
        and pg_get_expr(i.indpred, i.indrelid) = '(activity_id IS NULL)'
    ) as session_segment_unique_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_sparring_exposure_activity_fk'
        and conrelid = to_regclass('pilot.sparring_exposure') and contype = 'f'
    ) as activity_fk_kept,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_sparring_exposure_segment_uq'
        and conrelid = to_regclass('pilot.sparring_exposure') and contype = 'u'
    ) as linked_segment_unique_kept
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error('SPARRING_EXPOSURE_SESSION_DATE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_sparring_exposure_session_date_migration.sql',
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
  console.log('PILOT SPARRING EXPOSURE SESSION DATE MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SPARRING EXPOSURE SESSION DATE MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
