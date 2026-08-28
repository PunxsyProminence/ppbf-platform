import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the athlete-development-block-executions migration (module 036,
// slice 3) inside one transaction, with the same target-verification
// discipline as every other pilot:apply-* script: the operator must state
// which host and database they believe they are pointing at, and a mismatch
// refuses before any DDL runs.

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

// Every clause here is something the base schema does NOT already provide,
// so this assertion can genuinely refuse a database the migration never
// reached -- the property migrationReadinessGates.pg.test.ts exists to hold
// runners to, after #488 shipped one that could never pass and seven that
// could never fail.
//
// The vocabulary clause matches deparsed literals rather than source text:
// Postgres re-renders `x in (...)` from the parsed tree as
// `x = ANY (ARRAY['unknown'::text, ...])`, so the stable substrings are the
// quoted literals themselves.
//
// WHAT THIS DELIBERATELY DOES NOT ASSERT: the ABSENCE of any adherence value.
// A deploy gate that encoded which words the vocabulary excludes would refuse
// every dispatch the day the owner widens it, turning a one-line change into
// a blocked release. That the vocabulary is exactly five belongs in the
// migration test, which is edited in the same commit as the vocabulary; this
// gate asserts only that the constraint exists and holds real values.
//
// IT ALSO ASSERTS THE ABSENCE OF COUNT COLUMNS, which is not a vocabulary
// question but the whole point of the table (see the migration header). A
// deployed database that grew attempt_count or adherence_score is one this
// runner should refuse to call ready, because the surfaces above it promise
// that no such column exists.
const READINESS_QUERY = `
  select
    to_regclass('pilot.athlete_development_block_executions') is not null as table_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.athlete_development_block_executions')
        and contype = 'c'
        and conname = 'pilot_adb_executions_adherence_check'
        and pg_get_constraintdef(oid) like '%''unknown''%'
        and pg_get_constraintdef(oid) like '%''delivered_as_planned''%'
    ) as adherence_vocabulary_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.athlete_development_block_executions')
        and contype = 'f'
        and conname = 'pilot_adb_executions_block_fk'
        and confrelid = to_regclass('pilot.athlete_development_blocks')
    ) as block_tenancy_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.athlete_development_block_executions')
        and contype = 'u'
        and conname = 'pilot_adb_executions_one_per_block'
    ) as one_per_block_ready,
    not exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'athlete_development_block_executions'
        -- Matched as WHOLE underscore-separated words, not as substrings.
        -- A substring match reads 'recorded_by_account_id' as containing
        -- "count" and refuses a perfectly correct database -- which is
        -- exactly what the first version of this gate did, and what the pg
        -- suite caught before it could refuse a deploy.
        and column_name ~ '(^|_)(count|counts|score|scores|pct|percent|percentage|total|totals|tally|ratio|average|avg|index)(_|$)'
    ) as stores_no_tally
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('ATHLETE_DEVELOPMENT_BLOCK_EXECUTIONS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_athlete_development_block_executions_migration.sql',
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
  console.log(`Applied athlete development block executions migration: ${migrationPath}`);
  console.log('PILOT ATHLETE DEVELOPMENT BLOCK EXECUTIONS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ATHLETE DEVELOPMENT BLOCK EXECUTIONS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
