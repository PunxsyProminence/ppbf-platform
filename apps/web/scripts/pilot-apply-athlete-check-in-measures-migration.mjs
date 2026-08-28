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

// Readiness asserts the six columns AND the six range constraints, because
// this migration adds them in two separate statements: an environment that
// somehow gained the columns without the checks would accept a hydration of
// 47, and a column-only query would call that ready.
//
// The three PRE-EXISTING columns are asserted too (`pre_existing_intact`).
// This migration must not disturb energy, soreness or focus, and the cheapest
// place to notice that it did is here, on the environment itself, rather than
// downstream in a screen that renders a value it should never have accepted.
const READINESS_QUERY = `
  with columns as (
    select attname, atttypid::regtype::text as type_name
    from pg_attribute
    where attrelid = to_regclass('pilot.athlete_check_ins')
      and attnum > 0
      and not attisdropped
  ),
  constraints as (
    select conname from pg_constraint
    where conrelid = to_regclass('pilot.athlete_check_ins')
      and contype = 'c'
  )
  select
    to_regclass('pilot.athlete_check_ins') is not null as table_ready,
    (select count(*) = 6 from columns where attname in (
      'sleep_hours', 'hydration', 'motivation',
      'mental_clarity', 'stress', 'nutrition_compliance'
    )) as measure_columns_ready,
    (select type_name = 'numeric' from columns where attname = 'sleep_hours') as sleep_hours_is_numeric,
    (select count(*) = 6 from constraints where conname in (
      'pilot_athlete_check_ins_sleep_hours_check',
      'pilot_athlete_check_ins_hydration_check',
      'pilot_athlete_check_ins_motivation_check',
      'pilot_athlete_check_ins_mental_clarity_check',
      'pilot_athlete_check_ins_stress_check',
      'pilot_athlete_check_ins_nutrition_compliance_check'
    )) as range_constraints_ready,
    (select count(*) = 3 from columns where attname in ('energy', 'soreness', 'focus'))
      as pre_existing_intact
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('ATHLETE_CHECK_IN_MEASURES_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_athlete_check_in_measures_migration.sql',
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
  console.log(`Applied athlete check-in measures migration: ${migrationPath}`);
  console.log('PILOT ATHLETE CHECK IN MEASURES MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ATHLETE CHECK IN MEASURES MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
