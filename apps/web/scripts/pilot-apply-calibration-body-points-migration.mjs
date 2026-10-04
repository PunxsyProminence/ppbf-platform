import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the calibration-body-points migration inside one transaction, with
// the same target-verification discipline as every other pilot:apply-* script: the
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
// not run (the calibration tables are not in the base schema), which is what
// migrationReadinessGates.pg.test.ts exists to check.
//
// Asserted BY NAME out of pg_constraint, pg_trigger and pg_indexes, never by
// pg_get_constraintdef text: Postgres deparses a CHECK rather than echoing
// its source (issue #488).
//
// THE FOUR TRIGGERS ARE ASSERTED because they hold what the constraints
// cannot: the freeze on a submitted set, the body-point-version gate, the middle-moment
// rule, and the event and set facts a moment was checked against. Tables
// with their constraints and without their triggers look healthy and enforce
// none of that. A trigger present but disabled counts as missing.
//
// 0.3 IS ASSERTED TOO, because a database this migration reached before 0.3
// existed has every object above by name and still refuses solar_plexus. The
// clauses read a literal out of the CHECK's text and the two guards' source;
// a quoted literal survives Postgres's deparse.
const READINESS_QUERY = `
  select
    to_regclass('pilot.calibration_body_moments') is not null as moments_table_ready,
    to_regclass('pilot.calibration_body_points') is not null as points_table_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_annotation_events')
        and conname = 'pilot_calibration_events_bounds_key'
    ) as event_bounds_key_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_moments')
        and conname = 'pilot_calibration_body_moments_set_key'
    ) as moment_set_key_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_moments')
        and conname = 'pilot_calibration_body_moments_one_per_slot'
    ) as one_moment_per_slot_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_moments')
        and conname = 'pilot_calibration_body_moments_slot_vocab'
    ) as slot_vocab_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_moments')
        and conname = 'pilot_calibration_body_moments_kind_vocab'
    ) as kind_vocab_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_moments')
        and conname = 'pilot_calibration_body_moments_lead_side_vocab'
    ) as lead_side_vocab_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_moments')
        and conname = 'pilot_calibration_body_moments_guard_vocab'
    ) as guard_vocab_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_moments')
        and conname = 'pilot_calibration_body_moments_slot_kind'
    ) as slot_kind_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_moments')
        and conname = 'pilot_calibration_body_moments_within_event'
    ) as within_event_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_moments')
        and conname = 'pilot_calibration_body_moments_on_edge'
    ) as on_edge_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_moments')
        and conname = 'pilot_calibration_body_moments_frame_size'
    ) as frame_size_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_moments')
        and conname = 'pilot_calibration_body_moments_event_fk'
    ) as event_containment_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_moments')
        and conname = 'pilot_calibration_body_moments_set_fk'
    ) as set_containment_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_points')
        and conname = 'pilot_calibration_body_points_one_per_moment'
    ) as one_point_per_code_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_points')
        and conname = 'pilot_calibration_body_points_code_vocab'
    ) as point_code_vocab_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_points')
        and conname = 'pilot_calibration_body_points_code_vocab'
        and pg_get_constraintdef(oid) like '%''solar_plexus''%'
    ) as point_code_vocab_0_3_ready,
    exists (
      select 1 from pg_proc
      where oid = to_regprocedure('pilot.calibration_body_points_guard()')
        and prosrc like '%''boxing-ontology-0.3''%'
    ) as points_guard_0_3_ready,
    exists (
      select 1 from pg_proc
      where oid = to_regprocedure('pilot.calibration_body_moments_guard()')
        and prosrc like '%''boxing-ontology-0.3''%'
    ) as moments_guard_0_3_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_points')
        and conname = 'pilot_calibration_body_points_state_vocab'
    ) as state_vocab_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_points')
        and conname = 'pilot_calibration_body_points_position'
    ) as position_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_body_points')
        and conname = 'pilot_calibration_body_points_moment_fk'
    ) as moment_containment_ready,
    exists (
      select 1 from pg_trigger
      where tgrelid = to_regclass('pilot.calibration_body_moments')
        and tgname = 'pilot_calibration_body_moments_guard'
        and not tgisinternal
        and tgenabled <> 'D'
    ) as moments_guard_ready,
    exists (
      select 1 from pg_trigger
      where tgrelid = to_regclass('pilot.calibration_body_points')
        and tgname = 'pilot_calibration_body_points_guard'
        and not tgisinternal
        and tgenabled <> 'D'
    ) as points_guard_ready,
    exists (
      select 1 from pg_trigger
      where tgrelid = to_regclass('pilot.calibration_annotation_events')
        and tgname = 'pilot_calibration_events_body_moment_guard'
        and not tgisinternal
        and tgenabled <> 'D'
    ) as event_guard_ready,
    exists (
      select 1 from pg_trigger
      where tgrelid = to_regclass('pilot.calibration_annotation_sets')
        and tgname = 'pilot_calibration_sets_body_moment_guard'
        and not tgisinternal
        and tgenabled <> 'D'
    ) as set_version_guard_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_calibration_body_points_set'
    ) as points_set_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('CALIBRATION_BODY_POINTS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_calibration_body_points_migration.sql',
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
  console.log(`Applied calibration body points migration: ${migrationPath}`);
  console.log('PILOT CALIBRATION BODY POINTS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT CALIBRATION BODY POINTS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
