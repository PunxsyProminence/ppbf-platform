import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export function parseConnectionTarget(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('INVALID_POSTGRES_CONNECTION_STRING');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('INVALID_POSTGRES_PROTOCOL');
  }

  const hostname = parsed.hostname.toLowerCase();
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!hostname || !database) {
    throw new Error('INCOMPLETE_POSTGRES_TARGET');
  }

  return { hostname, database };
}

function assertExpectedTarget(target, expectedHostname, expectedDatabase) {
  if (
    target.hostname !== expectedHostname.toLowerCase()
    || target.database !== expectedDatabase
  ) {
    throw new Error('POSTGRES_TARGET_MISMATCH');
  }
}

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

// This is the only migration in this repository that REMOVES a constraint, so
// its readiness query has to assert an absence as well as a presence -- and the
// two are inseparable.
//
// `discipline_fk_still_governing` is first because it is the whole safety
// property. A database where the CHECK is gone AND the foreign key is gone has
// an ungoverned discipline column, and that state must never be reported as a
// successful dispatch. The migration SQL raises rather than dropping when the
// key is absent, so in practice this cannot be reached through the migration
// itself; it is asserted here anyway, because the runner's job is to describe
// the database it is leaving behind rather than to trust the file it just ran.
//
// `contype = 'f'` and `confrelid` are checked rather than the name alone, for
// the same reason the drill-library-discipline-fk runner checks them: a
// constraint of another kind carrying this name would satisfy a name-only
// lookup while enforcing something else entirely.
//
// Deliberately does NOT assert that the foreign key is still `not valid`. The
// `all` chain re-runs every migration on every dispatch, so this query runs
// again after any future, deliberate `validate constraint` -- and asserting
// `not convalidated` would turn a correctly validated environment into a
// failing dispatch. That is the same trap the FK runner recorded, and it is
// avoided here for the same reason.
//
// `discipline_check_dropped` is the migration's own effect, stated as an
// absence. It is the assertion that would catch the drop silently not
// happening -- a `drop constraint` inside a guard that never matched, or a
// migration file that was edited into a no-op.
const READINESS_QUERY = `
  select
    to_regclass('pilot.drill_library') is not null as library_table_ready,
    to_regclass('pilot.disciplines') is not null as registry_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_library_discipline_fk'
        and conrelid = to_regclass('pilot.drill_library')
        and contype = 'f'
        and confrelid = to_regclass('pilot.disciplines')
    ) as discipline_fk_still_governing,
    not exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_library_discipline_check'
        and conrelid = to_regclass('pilot.drill_library')
    ) as discipline_check_dropped
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('DRILL_LIBRARY_CHECK_DROP_NOT_READY');
  }
}

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    assertReadiness(readiness.rows[0]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function run() {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  const expectedHostname = required('PPBF_EXPECTED_POSTGRES_HOSTNAME');
  const expectedDatabase = required('PPBF_EXPECTED_POSTGRES_DATABASE');

  const target = parseConnectionTarget(connectionString);
  assertExpectedTarget(target, expectedHostname, expectedDatabase);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const migrationPath = path.resolve(
    __dirname,
    '../../../infra/azure/pilot_slice_postgres_drill_library_check_drop_migration.sql',
  );

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  try {
    await applyMigrationTransaction(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied drill library discipline CHECK drop migration: ${migrationPath}`);
  console.log('PILOT DRILL LIBRARY CHECK DROP MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT DRILL LIBRARY CHECK DROP MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
