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

// Deliberately does NOT assert that the constraint is still un-validated.
//
// The `all` chain re-runs every migration on every dispatch, so this query runs
// again after any future `validate constraint`. Asserting `not convalidated`
// would turn a correctly validated environment into a failing dispatch -- the
// readiness check would start refusing the very state it is meant to reach.
// That the constraint is created NOT VALID is a property of the migration, and
// is asserted where it belongs: drillLibraryDisciplineFk.pg.test.ts.
//
// `contype = 'f'` is checked rather than the name alone, because a CHECK
// constraint that happened to carry this name would satisfy a name-only lookup
// while enforcing something else entirely.
//
// `pre_existing_check_intact` is here because this migration's central promise
// is that it is ADDITIVE: it adds a foreign key and leaves
// pilot_drill_library_discipline_check exactly as it found it. That the two
// constraints disagree about 'general' and 'bjj' is reported as an open
// question rather than resolved by quietly dropping one of them -- so a future
// edit that DID drop the CHECK should not be able to reach a live environment
// through a dispatch that still reports PASS.
const READINESS_QUERY = `
  select
    to_regclass('pilot.disciplines') is not null as registry_ready,
    to_regclass('pilot.drill_library') is not null as library_table_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_library_discipline_fk'
        and conrelid = to_regclass('pilot.drill_library')
        and contype = 'f'
        and confrelid = to_regclass('pilot.disciplines')
    ) as discipline_fk_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_library_discipline_check'
        and conrelid = to_regclass('pilot.drill_library')
        and contype = 'c'
    ) as pre_existing_check_intact
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('DRILL_LIBRARY_DISCIPLINE_FK_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_drill_library_discipline_fk_migration.sql',
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
  console.log(`Applied drill library discipline FK migration: ${migrationPath}`);
  console.log('PILOT DRILL LIBRARY DISCIPLINE FK MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT DRILL LIBRARY DISCIPLINE FK MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
