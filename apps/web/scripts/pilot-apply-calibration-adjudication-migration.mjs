import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the calibration-adjudication migration inside one transaction, with the same
// target-verification discipline as every other pilot:apply-* script: the
// operator must state which host and database they believe they are
// pointing at, and a mismatch refuses before any DDL runs.

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

// Every clause below can go false against a database where this migration has
// not run, which is what migrationReadinessGates.pg.test.ts exists to check --
// a readiness query that can never be red is not a gate.
//
// The tenancy foreign keys are asserted BY NAME rather than by counting keys,
// because they are the whole safety claim of this migration: without them a
// clip could reference another organization's video or athlete. A table that
// exists without them is not ready, it is a hole.
//
// Constraint definitions are matched with pg_get_constraintdef only where the
// deparsed form is stable. Postgres rewrites `between 1 and 5` into
// `>= 1 AND <= 5` (issue #488, which blocked a real staging dispatch), so
// nothing here matches source text against a CHECK body.
// Every clause can go false against a database where this migration has not
// run. The two source foreign keys are asserted BY NAME because they are what
// keeps an adjudication attributable: without them a reviewer's decision could
// name an event from the wrong annotator's set, and the record would credit an
// observation to the wrong person.
const READINESS_QUERY = `
  select
    to_regclass('pilot.calibration_adjudications') is not null as adjudications_table_ready,
    to_regclass('pilot.calibration_adjudicated_fields') is not null as fields_table_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_annotation_events')
        and conname = 'pilot_calibration_events_clip_key'
    ) as event_clip_key_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_adjudications')
        and conname = 'pilot_calibration_adjudications_source_a_fk'
    ) as source_a_scoping_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_adjudications')
        and conname = 'pilot_calibration_adjudications_source_b_fk'
    ) as source_b_scoping_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_adjudications')
        and conname = 'pilot_calibration_adjudications_has_source'
    ) as has_source_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_adjudications')
        and conname = 'pilot_calibration_adjudications_verdict_supported'
    ) as verdict_supported_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'calibration_adjudications'
        and column_name = 'adjudicator_account_id'
        and is_nullable = 'NO'
    ) as attribution_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_adjudicated_fields')
        and conname = 'pilot_calibration_adjudicated_fields_uq'
    ) as one_decision_per_field_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_calibration_adjudicated_fields_category'
    ) as category_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('CALIBRATION_ADJUDICATION_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_calibration_adjudication_migration.sql',
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
  console.log(`Applied calibration adjudication migration: ${migrationPath}`);
  console.log('PILOT CALIBRATION ADJUDICATION MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT CALIBRATION ADJUDICATION MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
