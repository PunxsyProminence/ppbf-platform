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

// The property this migration promises, asserted from the other side.
//
// It deliberately does NOT assert that all three keys are validated. The
// migration SKIPS a constraint that is not installed rather than raising
// (OD-2026-08-28-006 and the SQL header explain why), and a readiness query
// demanding `convalidated` would convert every one of those skips back into the
// dispatch failure the skip exists to avoid -- on exactly the environments least
// able to absorb one.
//
// What it asserts instead is the thing that must be true after a successful run
// on ANY environment: NO un-validated discipline foreign key is left behind.
// Absent is fine, validated is fine, `not valid` is not. That is a real
// tripwire, not a tautology -- it is false on every environment where the keys
// exist and this migration has not run, which is the state it exists to leave.
//
// `contype = 'f'` is checked rather than the name alone, because a CHECK
// constraint wearing a foreign key's name would satisfy a name-only lookup while
// carrying an entirely different meaning of `convalidated`.
//
// `to_regclass` rather than a `::regclass` cast: the cast raises 42P01 where the
// table is absent, and a readiness check that throws on a table-less database
// would fail the skip path this runner is built to allow.
const READINESS_QUERY = `
  select
    not exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_library_discipline_fk'
        and conrelid = to_regclass('pilot.drill_library')
        and contype = 'f'
        and not convalidated
    ) as drill_library_fk_settled,
    not exists (
      select 1 from pg_constraint
      where conname = 'pilot_session_scripts_discipline_fk'
        and conrelid = to_regclass('pilot.session_scripts')
        and contype = 'f'
        and not convalidated
    ) as session_scripts_fk_settled,
    not exists (
      select 1 from pg_constraint
      where conname = 'pilot_cohortdef_discipline_fk'
        and conrelid = to_regclass('pilot.cohort_definitions')
        and contype = 'f'
        and not convalidated
    ) as cohort_definitions_fk_settled
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('DISCIPLINE_FK_VALIDATION_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_discipline_fk_validation_migration.sql',
  );

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  // The migration's whole reporting surface is `raise notice`, and the three
  // outcomes it distinguishes -- VALIDATED, NO-OP, SKIPPED -- are only legible
  // to an operator if they reach the dispatch log. node-postgres swallows
  // notices unless something listens, so this runner listens and prints them.
  // Without this the skip branch really would be silent, which is the failure
  // mode the guard was written to avoid.
  client.on('notice', (notice) => {
    if (notice?.message) {
      console.log(`postgres notice: ${notice.message}`);
    }
  });

  await client.connect();
  try {
    await applyMigrationTransaction(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied discipline FK validation migration: ${migrationPath}`);
  console.log('PILOT DISCIPLINE FK VALIDATION MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT DISCIPLINE FK VALIDATION MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
