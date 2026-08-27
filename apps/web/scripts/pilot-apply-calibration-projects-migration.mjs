import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the calibration-projects migration inside one transaction, with the same
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
const READINESS_QUERY = `
  select
    to_regclass('pilot.calibration_projects') is not null as projects_table_ready,
    to_regclass('pilot.calibration_clips') is not null as clips_table_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.video_sessions')
        and conname = 'pilot_video_sessions_org_video_uq'
    ) as video_tenancy_key_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_clips')
        and conname = 'pilot_calibration_clips_video_fk'
    ) as clip_video_fk_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_clips')
        and conname = 'pilot_calibration_clips_project_fk'
    ) as clip_project_fk_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_clips')
        and conname = 'pilot_calibration_clips_athlete_fk'
    ) as clip_athlete_fk_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_clips')
        and conname = 'pilot_calibration_clips_bounds'
    ) as clip_bounds_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_clips')
        and conname = 'pilot_calibration_clips_code_uq'
    ) as clip_code_uniqueness_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'calibration_projects'
        and column_name = 'ontology_version'
        and is_nullable = 'NO'
    ) as ontology_version_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_calibration_clips_sampling_reason'
    ) as sampling_stratum_index_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_calibration_clips_video'
    ) as clip_video_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('CALIBRATION_PROJECTS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_calibration_projects_migration.sql',
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
  console.log(`Applied calibration projects migration: ${migrationPath}`);
  console.log('PILOT CALIBRATION PROJECTS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT CALIBRATION PROJECTS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
