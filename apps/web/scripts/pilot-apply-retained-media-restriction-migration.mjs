import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the retained-media-restriction migration inside one transaction.
// The operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// The postcondition, not the statement: the table exists and BOTH foreign keys
// cascade (confdeltype 'c'). A restricting athlete key would make every
// athlete purge of a child with a retained restriction fail; a restricting
// waiver key would do the same one table over. to_regclass() so an absent
// table reads as not ready rather than raising before the check runs.
export const READINESS_QUERY = `
  select
    to_regclass('pilot.retained_media_consent_restrictions') is not null as table_exists,
    (select count(*)::int from pg_constraint
      where conrelid = to_regclass('pilot.retained_media_consent_restrictions')
        and contype = 'f' and confdeltype = 'c'
        and conname in ('pilot_retained_media_consent_restrictions_athlete_fk',
                        'pilot_retained_media_consent_restrictions_waiver_fk')) as cascading_fks
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const ready = (await client.query(READINESS_QUERY)).rows[0];
    if (!ready?.table_exists || ready.cascading_fks !== 2) {
      throw new Error(`RETAINED_MEDIA_RESTRICTION_NOT_READY: table_exists=${ready?.table_exists} cascading_fks=${ready?.cascading_fks}`);
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
    '../../../infra/azure/pilot_slice_postgres_retained_media_restriction_migration.sql',
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
  console.log('PILOT RETAINED MEDIA RESTRICTION MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT RETAINED MEDIA RESTRICTION MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
