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

// Same reasoning as db.ts's resolveSslConfig and the other pilot-apply-*
// scripts: production/staging always require TLS.
function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

// Asserts the properties the migration exists for, not merely that two columns
// by those names appeared.
//
// `columns_nullable_ready` is the one that would be easiest to lose and worst
// to lose. The whole argument in the SQL header is that pre-existing goals must
// keep NULL rather than be backfilled with an invented category and a zeroed
// progress reading. A NOT NULL variant of this migration -- or a hand-run
// `alter ... set not null` afterwards -- would force a default onto every row
// that predates it, which is the fabrication this change was written to remove.
// A name-only check passes happily against that database.
//
// `category_vocabulary_ready` matches QUOTED literals so a value cannot be
// satisfied by appearing inside the column name or inside another value, and it
// asserts the two weight values are ABSENT. That absence is a deliberate,
// documented product decision (see the SQL header), so it is asserted rather
// than merely omitted -- if someone widens the vocabulary, this runner should
// be the thing that notices, not a coach reading a report.
//
// `progress_bounds_ready` asserts both ends of the range. A check constraint
// with only a lower bound admits 4000%, which the progress bar would render as
// a forty-times-overflowing div.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// column is evaluated when the table is absent, which would report an
// unmigrated database as a SQL error instead of as unreadiness.
// A DEPLOY GATE MUST NOT ENCODE A POLICY THAT CAN CHANGE.
//
// This assertion used to carry two more clauses:
//
//   and pg_get_constraintdef(oid) not like '%''Weight Loss''%'
//   and pg_get_constraintdef(oid) not like '%''Weight Gain''%'
//
// They asserted that the two withheld categories were ABSENT, which was true
// when written and became false on 2026-08-28 when the owner admitted them.
// The effect was not a wrong comment: the runner REFUSED a correctly migrated
// database, so `pilot:apply-goal-category-progress` -- and therefore the
// `all` chain that runs it -- could not be dispatched to any environment
// until this line was removed. A vocabulary decision had been wired into the
// release path.
//
// Found by goalCategoryProgress.pg.test.ts failing on the reversal, which is
// the cheap place to find it. The expensive place is a staging dispatch, and
// #488 is what that costs.
//
// What stays: the SEVEN categories this vocabulary has always carried, as
// positive assertions. What must never come back, in either direction: a
// clause about 'Weight Loss' or 'Weight Gain'. Asserting they are present
// would be the same landmine pointed the other way -- it would refuse every
// dispatch if the owner ever withheld them again. The vocabulary's exact
// membership is the migration's business and the migration test's; this gate
// checks that the constraint exists and holds real values.
const READINESS_QUERY = `
  select
    to_regclass('pilot.goals') is not null as goals_ready,
    (
      select count(*) = 2
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'goals'
        and column_name in ('category', 'progress_percent')
    ) as columns_ready,
    (
      select count(*) = 2
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'goals'
        and column_name in ('category', 'progress_percent')
        and is_nullable = 'YES'
    ) as columns_nullable_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'goals'
        and column_name = 'progress_percent'
        and data_type = 'integer'
    ) as progress_integer_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_goals_category_check'
        and conrelid = to_regclass('pilot.goals')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%''Boxing''%'
        and pg_get_constraintdef(oid) like '%''Fitness''%'
        and pg_get_constraintdef(oid) like '%''Academics''%'
        and pg_get_constraintdef(oid) like '%''Attendance''%'
        and pg_get_constraintdef(oid) like '%''Recovery''%'
        and pg_get_constraintdef(oid) like '%''Lifestyle''%'
        and pg_get_constraintdef(oid) like '%''Leadership''%'
    ) as category_vocabulary_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_goals_progress_percent_check'
        and conrelid = to_regclass('pilot.goals')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%>= 0%'
        and pg_get_constraintdef(oid) like '%<= 100%'
    ) as progress_bounds_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('GOAL_CATEGORY_PROGRESS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_goal_category_progress_migration.sql',
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
  console.log(`Applied goal category/progress migration: ${migrationPath}`);
  console.log('PILOT GOAL CATEGORY PROGRESS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT GOAL CATEGORY PROGRESS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
