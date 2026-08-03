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

// Asserts what the migration produced, and specifically the properties whose
// absence would be silent:
//
// `goal_target_date_nullable` -- the whole point of touching pilot.goals. A
// goal in somebody's own words ("show up on the days I don't want to") has no
// deadline, and a NOT NULL target_date forces an athlete to invent one.
//
// `recognition_vocabulary_positive` matches the QUOTED literals of four of the
// positive values, and `recognition_vocabulary_has_no_negative` asserts the
// constraint definition contains none of the words a disciplinary vocabulary
// would need. A check constraint that had been widened to admit 'concern' or
// 'incident' would pass a name-only check while inverting what this table is.
//
// `recognition_has_no_score_column` asserts the absence of every column shape a
// leaderboard needs. Ranking athletes against each other requires a comparable
// per-athlete number; the guarantee is that the table has none to offer, and a
// later migration quietly adding `points` should fail here rather than ship.
//
// `milestone_award_is_unique_per_athlete` asserts the primary key spans
// (organization_id, athlete_id, milestone_key). Without the milestone_key in
// the key an athlete could hold one milestone many times, which is the first
// countable quantity per athlete this schema would have.
//
// `mentorship_one_open_pair` asserts the index is UNIQUE and PARTIAL: unique so
// one pairing cannot be opened twice, partial (on ended_on is null) so the same
// two people can be paired again in a later season.
//
// `program_is_not_gym_status` asserts pilot.athlete_programs has its own
// program column rather than reaching into pilot.athletes.gym_status, which is
// classified as body data.
//
// to_regclass() rather than the ::regclass cast throughout: the cast raises
// before any column is evaluated when the table is absent, which would report
// an unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    (
      select count(*) = 5
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'goals'
        and column_name in ('goal_kind', 'own_words', 'why_it_matters', 'set_by_role', 'reached_at')
    ) as goal_columns_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'goals'
        and column_name = 'target_date'
        and is_nullable = 'YES'
    ) as goal_target_date_nullable,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_goals_kind_check'
        and conrelid = to_regclass('pilot.goals')
        and pg_get_constraintdef(oid) like '%''own_words''%'
    ) as goal_kind_vocabulary_ready,
    to_regclass('pilot.recognitions') is not null as recognitions_ready,
    (
      select count(*) = 8
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'recognitions'
        and column_name in (
          'organization_id', 'recognition_id', 'athlete_id', 'coach_account_id',
          'coach_display_name', 'kind', 'note', 'created_at'
        )
    ) as recognition_columns_ready,
    (
      select count(*) = 0
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'recognitions'
        and column_name in ('score', 'points', 'rating', 'rank', 'severity', 'weight', 'visibility')
    ) as recognition_has_no_score_column,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_recognitions_kind_check'
        and conrelid = to_regclass('pilot.recognitions')
        and pg_get_constraintdef(oid) like '%''helped_someone''%'
        and pg_get_constraintdef(oid) like '%''showed_up_hard_day''%'
        and pg_get_constraintdef(oid) like '%''good_partner''%'
        and pg_get_constraintdef(oid) like '%''left_it_better''%'
    ) as recognition_vocabulary_positive,
    (
      select count(*) = 0
      from pg_constraint
      where conname = 'pilot_recognitions_kind_check'
        and conrelid = to_regclass('pilot.recognitions')
        and (
          pg_get_constraintdef(oid) ilike '%concern%'
          or pg_get_constraintdef(oid) ilike '%incident%'
          or pg_get_constraintdef(oid) ilike '%warning%'
          or pg_get_constraintdef(oid) ilike '%violation%'
          or pg_get_constraintdef(oid) ilike '%discipline%'
        )
    ) as recognition_vocabulary_has_no_negative,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_recognitions_note_length_check'
        and conrelid = to_regclass('pilot.recognitions')
    ) as recognition_note_capped,
    exists (
      select 1
      from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_pilot_recognitions_org_athlete_created'
    ) as recognition_read_index_ready,
    to_regclass('pilot.athlete_milestones') is not null as milestones_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_athlete_milestones_pkey'
        and conrelid = to_regclass('pilot.athlete_milestones')
        and contype = 'p'
        and pg_get_constraintdef(oid) like '%(organization_id, athlete_id, milestone_key)%'
    ) as milestone_award_is_unique_per_athlete,
    (
      select count(*) = 0
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'athlete_milestones'
        and column_name in ('score', 'points', 'expires_at', 'streak', 'rank')
    ) as milestone_has_no_score_or_expiry,
    to_regclass('pilot.mentorships') is not null as mentorships_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.mentorships')
        and c.relname = 'pilot_mentorships_one_open_pair'
        and i.indisunique
        and i.indpred is not null
    ) as mentorship_one_open_pair,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_mentorships_distinct_people_check'
        and conrelid = to_regclass('pilot.mentorships')
    ) as mentorship_distinct_people,
    to_regclass('pilot.athlete_programs') is not null as programs_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'athlete_programs'
        and column_name = 'program'
    ) as program_is_not_gym_status,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_athlete_programs_program_check'
        and conrelid = to_regclass('pilot.athlete_programs')
        and pg_get_constraintdef(oid) like '%''fitness''%'
        and pg_get_constraintdef(oid) like '%''youth''%'
        and pg_get_constraintdef(oid) like '%''recreational''%'
        and pg_get_constraintdef(oid) like '%''competitive''%'
    ) as program_vocabulary_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('ACHIEVEMENTS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_achievements_migration.sql',
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
  console.log(`Applied achievements migration: ${migrationPath}`);
  console.log('PILOT ACHIEVEMENTS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ACHIEVEMENTS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
