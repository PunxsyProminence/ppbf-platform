import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the workout-issues migration inside one transaction. The operator
// names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Readiness asserts both tables and every guard ON THEM (looked up by
// conrelid, not by name alone), so an environment where a table exists without
// one of its checks, foreign keys or indexes cannot pass. Every CHECK is
// compared IN FULL against the text Postgres stores for it; every foreign key
// by shape (both column lists, target table, ON DELETE action); each clause is
// refused on its own (workoutIssues.pg.test.ts).
const EXPECTED_CHECKS = [
  ['workout_issues', 'pilot_workout_issues_request_key_check',
    'CHECK (((request_key IS NULL) OR ((length(btrim(request_key)) > 0) AND (length(request_key) <= 200))))'],
  ['workout_issue_steps', 'pilot_workout_issue_steps_ordinal_check', 'CHECK ((ordinal > 0))'],
  ['workout_issue_steps', 'pilot_workout_issue_steps_scale_level_check',
    "CHECK (((scale_level IS NULL) OR (scale_level = ANY (ARRAY['A'::text, 'B'::text, 'C'::text]))))"],
  ['workout_issue_steps', 'pilot_workout_issue_steps_contact_level_check',
    "CHECK ((contact_level = ANY (ARRAY['none'::text, 'light_technical'::text, 'conditioned'::text, 'controlled_sparring'::text, 'open_sparring'::text])))"],
];

// [constraint, table, target table, ON DELETE (c = cascade, a = no action), columns, target columns]
const EXPECTED_FOREIGN_KEYS = [
  ['pilot_workout_issues_athlete_fk', 'workout_issues', 'athletes', 'c', 'organization_id,athlete_id', 'organization_id,athlete_id'],
  ['pilot_workout_issues_template_fk', 'workout_issues', 'workout_templates', 'a', 'organization_id,template_id', 'organization_id,template_id'],
  ['pilot_workout_issue_steps_issue_fk', 'workout_issue_steps', 'workout_issues', 'c', 'organization_id,issue_id', 'organization_id,issue_id'],
  ['pilot_workout_issue_steps_assignment_fk', 'workout_issue_steps', 'drill_assignments', 'c', 'assignment_id', 'assignment_id'],
];

// [index, table, the tail of the definition Postgres stores]
const EXPECTED_INDEXES = [
  ['pilot_workout_issue_steps_one_per_assignment', 'workout_issue_steps', 'UNIQUE%(assignment_id)'],
  ['pilot_workout_issues_one_per_request_key', 'workout_issues', 'UNIQUE%(organization_id, request_key) WHERE (request_key IS NOT NULL)'],
  ['idx_workout_issues_athlete', 'workout_issues', '%(organization_id, athlete_id, issued_at DESC)'],
];

const column = (rows, index) => rows.map((row) => row[index]);

const READINESS_QUERY = `
  select
    to_regclass('pilot.workout_issues') is not null as workout_issues_ready,
    to_regclass('pilot.workout_issue_steps') is not null as workout_issue_steps_ready,
    (
      select count(*) = $1 from pg_constraint c
      join unnest($2::text[], $3::text[], $4::text[]) as expected(tablename, conname, condef)
        on expected.conname = c.conname and c.conrelid = to_regclass('pilot.' || expected.tablename)
      where c.contype = 'c' and c.convalidated and pg_get_constraintdef(c.oid) = expected.condef
    ) as checks_ready,
    (
      select count(*) = $5 from pg_constraint c
      join unnest($6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
        as expected(conname, tablename, target, on_delete, cols, target_cols)
        on expected.conname = c.conname and c.conrelid = to_regclass('pilot.' || expected.tablename)
      where c.contype = 'f' and c.convalidated
        and c.confrelid = to_regclass('pilot.' || expected.target)
        and c.confdeltype::text = expected.on_delete
        and (select string_agg(a.attname::text, ',' order by k.ord)
               from unnest(c.conkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) = expected.cols
        and (select string_agg(a.attname::text, ',' order by k.ord)
               from unnest(c.confkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum) = expected.target_cols
    ) as foreign_keys_ready,
    (
      select count(*) = $12 from pg_indexes i
      join unnest($13::text[], $14::text[], $15::text[]) as expected(indexname, tablename, tail)
        on expected.indexname = i.indexname and expected.tablename = i.tablename
      where i.schemaname = 'pilot' and i.indexdef like '%' || expected.tail
    ) as indexes_ready
`;
const READINESS_PARAMS = [
  EXPECTED_CHECKS.length, column(EXPECTED_CHECKS, 0), column(EXPECTED_CHECKS, 1), column(EXPECTED_CHECKS, 2),
  EXPECTED_FOREIGN_KEYS.length,
  ...[0, 1, 2, 3, 4, 5].map((index) => column(EXPECTED_FOREIGN_KEYS, index)),
  EXPECTED_INDEXES.length, column(EXPECTED_INDEXES, 0), column(EXPECTED_INDEXES, 1), column(EXPECTED_INDEXES, 2),
];

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY, READINESS_PARAMS);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error('WORKOUT_ISSUES_NOT_READY');
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function run() {
  const connectionString = process.env.AZURE_POSTGRES_CONNECTION_STRING?.trim();
  if (!connectionString) throw new Error('MISSING_AZURE_POSTGRES_CONNECTION_STRING');
  const target = assertDeclaredWriteTargetFromEnv(connectionString);

  const migrationPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../infra/azure/pilot_slice_postgres_workout_issues_migration.sql',
  );
  const sql = await fs.readFile(migrationPath, 'utf8');
  const client = new Client({ connectionString, ssl: sslConfig() });
  await client.connect();
  try {
    await applyMigrationTransaction(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied workout issues migration: ${migrationPath}`);
  console.log('PILOT WORKOUT ISSUES MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT WORKOUT ISSUES MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
