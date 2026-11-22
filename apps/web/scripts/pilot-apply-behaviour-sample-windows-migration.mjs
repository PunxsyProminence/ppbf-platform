import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the behaviour sample windows migration (PATTERN-1d,
// PunxsyProminence/ppbf-platform#2082) inside one transaction. Run by Overwatch only (Q2 A).
// The operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// A trigger by name ON its table: BEFORE (2), ROW (1), firing in ordinary sessions, calling the
// named function, on every event in `events` (INSERT 4, DELETE 8, UPDATE 16).
const triggerReady = (table, trigger, fn, events) => `exists (
      select 1 from pg_trigger t
       where t.tgrelid = to_regclass('${table}') and t.tgname = '${trigger}' and not t.tgisinternal
         and t.tgenabled in ('O', 'A') and (t.tgtype & 3) = 3 and (t.tgtype & ${events}) = ${events}
         and t.tgfoid = to_regprocedure('${fn}')
    )`;

const constraintReady = (table, name, type) => `exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('${table}') and c.conname = '${name}' and c.contype = '${type}'
         and c.convalidated
    )`;

const WINDOWS = 'pilot.behaviour_observations_windows';

// Readiness asserts the result, not the attempt: the table, its keys, the token-shaped
// de-identify check, the guard on every event, and the athlete follow trigger.
const READINESS_QUERY = `
  select
    to_regclass('${WINDOWS}') is not null as windows_table_ready,
    ${constraintReady(WINDOWS, 'pilot_behaviour_windows_pkey', 'p')} as pkey_ready,
    ${constraintReady(WINDOWS, 'pilot_behaviour_windows_key_fk', 'f')} as key_fk_ready,
    ${constraintReady(WINDOWS, 'pilot_behaviour_windows_run_fk', 'f')} as run_fk_ready,
    ${constraintReady(WINDOWS, 'pilot_behaviour_windows_chances_check', 'c')} as chances_check_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('${WINDOWS}')
         and c.conname = 'pilot_behaviour_windows_deidentified_check' and c.contype = 'c' and c.convalidated
         and pg_get_constraintdef(c.oid) like '%anon_[0-9a-f]{8}-%'
    ) as deidentified_check_ready,
    ${triggerReady(WINDOWS, 'trg_behaviour_observations_windows_guard', 'pilot.behaviour_observations_windows_guard()', 28)} as guard_ready,
    ${triggerReady('pilot.athletes', 'pilot_behaviour_observations_windows_follow_athlete', 'pilot.behaviour_observations_windows_follow_athlete()', 8)} as follow_athlete_ready
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    // The migration adds a trigger on pilot.athletes under an exclusive lock held to
    // commit; rather than queue the roster behind a long reader, give up and let the
    // operator re-run in a quieter moment.
    await client.query("set local lock_timeout = '10s'");
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`BEHAVIOUR_SAMPLE_WINDOWS_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_behaviour_sample_windows_migration.sql',
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
  console.log(`Applied behaviour sample windows migration: ${migrationPath}`);
  console.log('PILOT BEHAVIOUR SAMPLE WINDOWS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT BEHAVIOUR SAMPLE WINDOWS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
