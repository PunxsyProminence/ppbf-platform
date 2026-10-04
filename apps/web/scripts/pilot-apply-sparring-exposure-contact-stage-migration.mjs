import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the sparring-exposure-contact-stage migration inside one transaction.
// The operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Every clause is false on a database this migration has not reached
// (sparringExposureContactStage.pg.test.ts). The check's own text is compared,
// so a column that exists without the ladder guard does not pass.
const READINESS_QUERY = `
  select
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'sparring_exposure'
        and column_name = 'contact_stage' and data_type = 'text' and is_nullable = 'YES'
    ) as contact_stage_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_sparring_exposure_contact_stage_check'
        and conrelid = to_regclass('pilot.sparring_exposure') and contype = 'c'
        and convalidated
        and pg_get_constraintdef(oid) like '%''none''%'
        and pg_get_constraintdef(oid) like '%''light_technical''%'
        and pg_get_constraintdef(oid) like '%''conditioned''%'
        and pg_get_constraintdef(oid) like '%''controlled_sparring''%'
        and pg_get_constraintdef(oid) like '%''open_sparring''%'
    ) as contact_stage_check_ready
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error('SPARRING_EXPOSURE_CONTACT_STAGE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_sparring_exposure_contact_stage_migration.sql',
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
  console.log('PILOT SPARRING EXPOSURE CONTACT STAGE MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SPARRING EXPOSURE CONTACT STAGE MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
