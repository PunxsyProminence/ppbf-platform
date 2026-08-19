import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the film-study coach-reported migration inside one transaction, with
// the same target-verification discipline as every other pilot:apply-* script:
// the operator must state which host and database they believe they are
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

// Verifies the two gaps this migration closes are actually closed: a row can
// state where it came from, a coach can be named as the reporter, a correction
// can carry replacement wording, and the model-provenance columns are no
// longer universally required.
const READINESS_QUERY = `
  select
    to_regclass('pilot.shadow_film_study_proposals') is not null as table_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_film_study_proposals'
        and column_name = 'origin'
        and is_nullable = 'NO'
        and column_default is null
    ) as origin_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_film_study_proposals'
        and column_name = 'reported_by_account_id'
    ) as reporter_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_film_study_proposals'
        and column_name = 'corrected_observation_text'
    ) as correction_column_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_film_study_proposals'
        and column_name = 'model_deployment'
        and is_nullable = 'YES'
    ) as model_deployment_conditional,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_film_study_proposals'
        and column_name = 'frames_analyzed'
        and is_nullable = 'YES'
    ) as frames_analyzed_conditional,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.shadow_film_study_proposals')
        and conname = 'pilot_film_study_proposals_origin_check'
    ) as origin_check_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.shadow_film_study_proposals')
        and conname = 'pilot_film_study_proposals_provenance'
    ) as provenance_check_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.shadow_film_study_proposals')
        and contype = 'c'
        and conname = 'pilot_film_study_proposals_review_state_check'
        and pg_get_constraintdef(oid) like '%corrected%'
    ) as corrected_verdict_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.shadow_film_study_proposals')
        and conname = 'pilot_film_study_proposals_attested_v2'
    ) as attestation_ready,
    -- Either name satisfies this: film-study-revisions, later in the same
    -- 'all' chain, drops ..._correction_check and replaces it with
    -- ..._correction_check_v2. Asserting only the original name means this
    -- runner cannot pass on any database that has reached the end of the
    -- chain -- the correctly-migrated end state is the one it would reject.
    -- What actually has to be true is that corrected_observation_text is
    -- governed by a correction check, not which revision of it is in force.
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.shadow_film_study_proposals')
        and contype = 'c'
        and conname in (
          'pilot_film_study_proposals_correction_check',
          'pilot_film_study_proposals_correction_check_v2'
        )
    ) as correction_check_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_film_study_proposals_model_settled'
    ) as model_settled_index_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_film_study_proposals_coach_reported'
    ) as coach_reported_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('FILM_STUDY_COACH_REPORTED_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_film_study_coach_reported_migration.sql',
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
  console.log(`Applied film study coach-reported migration: ${migrationPath}`);
  console.log('PILOT FILM STUDY COACH REPORTED MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT FILM STUDY COACH REPORTED MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
