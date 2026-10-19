import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the staff display name migration (coach display names, Q1 part B)
// inside one transaction. The operator names the host and database they believe
// they are pointing at (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch
// refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Readiness asserts the result, not the attempt, each piece looked up ON
// pilot.account_profiles so a same-named object elsewhere does not pass. The
// table first, by itself: it comes from the profile-identity migration, and
// when it is missing the operator is told that, not that a column is missing.
// Then the column as nullable text with no default (a default would name every
// existing coach the same thing), and the check, validated, compared IN FULL
// against the text Postgres stores for this migration's own check
// (staffDisplayName.pg.test.ts).
const EXPECTED_CHECK = 'CHECK (((staff_display_name IS NULL) OR (((char_length(staff_display_name) >= 1) AND (char_length(staff_display_name) <= 60)) AND (staff_display_name = btrim(staff_display_name)))))';

const READINESS_QUERY = `
  select
    to_regclass('pilot.account_profiles') is not null as table_ready,
    exists (
      select 1 from pg_attribute a
       where a.attrelid = to_regclass('pilot.account_profiles')
         and a.attname = 'staff_display_name' and not a.attisdropped
         and a.atttypid = 'text'::regtype and not a.attnotnull and not a.atthasdef
    ) as column_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.account_profiles')
         and c.conname = 'pilot_account_profiles_staff_display_name_check'
         and c.contype = 'c' and c.convalidated
         and pg_get_constraintdef(c.oid) = $1
    ) as check_ready
`;

// Runs before the file, so a database without pilot.account_profiles is refused
// by name instead of failing on the ALTER with a bare "relation does not exist".
const TABLE_QUERY = `select to_regclass('pilot.account_profiles') is not null as table_ready`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    // The column and the check take a brief exclusive lock on pilot.account_profiles, which
    // the profile and portrait screens read. Rather than queue behind a long transaction
    // already holding a lock there, give up and let the operator re-run in a quieter moment.
    // Nothing is half-applied: it is one transaction.
    const table = await client.query(TABLE_QUERY);
    if (table.rows[0]?.table_ready !== true) {
      throw new Error('STAFF_DISPLAY_NAME_NOT_READY: table_ready (pilot.account_profiles is missing; apply profile-identity first)');
    }
    await client.query("set local lock_timeout = '10s'");
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY, [EXPECTED_CHECK]);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`STAFF_DISPLAY_NAME_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_staff_display_name_migration.sql',
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
  console.log(`Applied staff display name migration: ${migrationPath}`);
  console.log('PILOT STAFF DISPLAY NAME MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT STAFF DISPLAY NAME MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
