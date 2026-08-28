import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the athlete-check-ins skeleton migration inside one transaction,
// with the same target-verification discipline as every other pilot:apply-*
// script: the operator must state which host and database they believe they
// are pointing at, and a mismatch refuses before any DDL runs.

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

const READINESS_QUERY = `
  select
    to_regclass('pilot.athlete_check_ins') is not null as check_ins_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_athlete_check_ins_one_per_day'
    ) as one_per_day_ready,
    -- The three wellness columns (energy, soreness, focus) are each bounded
    -- 1 to 5. The migration SQL writes that as a BETWEEN, but Postgres DOES
    -- NOT store the text it was given: pg_get_constraintdef() deparses from
    -- the parsed tree, so BETWEEN comes back as a >= and <= pair. The
    -- previous pattern here searched for the literal lowercase BETWEEN form,
    -- which Postgres never emits, so this assertion could not pass on any
    -- database -- the schema was always correct and the check was always
    -- wrong (staging run 32257652780). Matching the deparsed form instead is
    -- also the more durable check: it holds whether the SQL is written with
    -- BETWEEN or with explicit comparisons. Counting 3 rather than using
    -- exists() keeps it honest if a column silently loses its bound.
    --
    -- IT NOW COUNTS THE THREE NAMED COLUMNS, NOT EVERY 1-5 CONSTRAINT ON THE
    -- TABLE. The previous form asked pg_constraint for all single-column 1-5
    -- checks and demanded exactly 3, which quietly also meant "and no other
    -- column on this table is bounded 1 to 5". That held only while these
    -- were the only wellness measures. The owner's growth model for this
    -- table is one migration per measure decided, and the first of those
    -- (athlete-check-in-measures) adds five more 1-5 columns -- taking the
    -- count to 8 and failing this gate against a schema that is entirely
    -- correct. It failed inside the all chain, which is what a rebuild and
    -- a real dispatch both run.
    --
    -- Joining to the column and naming the three keeps the assertion aimed at
    -- what THIS runner installed, and leaves later measures free to add their
    -- own bounds without renegotiating this gate. array_length(conkey, 1) = 1
    -- restricts it to single-column checks, so a future multi-column
    -- constraint cannot be miscounted as one of these three.
    (
      select count(*) = 3
      from pg_constraint c
      join pg_attribute a
        on a.attrelid = c.conrelid
       and a.attnum = c.conkey[1]
      where c.conrelid = to_regclass('pilot.athlete_check_ins')
        and c.contype = 'c'
        and array_length(c.conkey, 1) = 1
        and a.attname in ('energy', 'soreness', 'focus')
        and pg_get_constraintdef(c.oid) like '%>= 1%'
        and pg_get_constraintdef(c.oid) like '%<= 5%'
    ) as wellness_bounds_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('ATHLETE_CHECK_INS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_athlete_check_ins_migration.sql',
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
  console.log(`Applied athlete check-ins migration: ${migrationPath}`);
  console.log('PILOT ATHLETE CHECK INS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ATHLETE CHECK INS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
