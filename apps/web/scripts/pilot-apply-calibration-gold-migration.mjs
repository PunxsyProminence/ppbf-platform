import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the calibration-gold migration inside one transaction, with the same
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
// Constraint definitions are matched with pg_get_constraintdef nowhere in this
// file. Postgres deparses a CHECK from the parsed tree rather than echoing its
// source -- it rewrites `between 1 and 5` into `>= 1 AND <= 5` (issue #488,
// which blocked a real staging dispatch) -- so everything here is asserted BY
// NAME out of pg_constraint, pg_trigger and pg_indexes.
//
// THE THREE TRIGGERS ARE ASSERTED, and they are the reason this gate matters
// more than most. The CHECK constraints on this table stop a malformed row;
// the triggers are what stop a WELL-FORMED one that should not exist -- a
// record born already promoted, a held-out LOCKED_TEST record quietly
// reclassified as training data, a promoted record repointed at somebody
// else's reading. A table that exists with its constraints and without its
// triggers looks completely healthy and enforces none of that. It is not
// ready; it is a hole with a schema.
const READINESS_QUERY = `
  select
    to_regclass('pilot.calibration_gold_records') is not null as gold_table_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_clips')
        and conname = 'pilot_calibration_clips_provenance_key'
    ) as clip_provenance_key_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_adjudications')
        and conname = 'pilot_calibration_adjudications_provenance_key'
    ) as adjudication_provenance_key_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_gold_records')
        and conname = 'pilot_calibration_gold_clip_fk'
    ) as clip_scoping_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_gold_records')
        and conname = 'pilot_calibration_gold_adjudication_fk'
    ) as adjudication_scoping_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_gold_records')
        and conname = 'pilot_calibration_gold_set_a_fk'
    ) as annotator_a_provenance_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_gold_records')
        and conname = 'pilot_calibration_gold_set_b_fk'
    ) as annotator_b_provenance_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_gold_records')
        and conname = 'pilot_calibration_gold_promotion_attested'
    ) as promotion_attested_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.calibration_gold_records')
        and conname = 'pilot_calibration_gold_one_per_adjudication'
    ) as one_record_per_adjudication_ready,
    exists (
      select 1 from pg_trigger
      where tgrelid = to_regclass('pilot.calibration_gold_records')
        and tgname = 'pilot_calibration_gold_born_candidate'
        and not tgisinternal
    ) as born_candidate_trigger_ready,
    exists (
      select 1 from pg_trigger
      where tgrelid = to_regclass('pilot.calibration_gold_records')
        and tgname = 'pilot_calibration_gold_eligibility_ratchet'
        and not tgisinternal
    ) as eligibility_ratchet_trigger_ready,
    exists (
      select 1 from pg_trigger
      where tgrelid = to_regclass('pilot.calibration_gold_records')
        and tgname = 'pilot_calibration_gold_freeze_provenance'
        and not tgisinternal
    ) as freeze_provenance_trigger_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'calibration_gold_records'
        and column_name = 'eligibility'
        and is_nullable = 'NO'
        and column_default is null
    ) as eligibility_required_and_undefaulted,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'calibration_gold_records'
        and column_name = 'promoted_by_account_id'
        and is_nullable = 'YES'
    ) as promotion_starts_unattributed,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_calibration_gold_eligibility'
    ) as held_out_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('CALIBRATION_GOLD_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_calibration_gold_migration.sql',
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
  console.log(`Applied calibration gold migration: ${migrationPath}`);
  console.log('PILOT CALIBRATION GOLD MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT CALIBRATION GOLD MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
