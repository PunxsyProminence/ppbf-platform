import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the athlete-rest-marks migration (lane R6-b1, OD-2026-11-17-004)
// inside one transaction. The operator names the host and database they
// believe they are pointing at (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE);
// a mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Asserts the table, its read index, its exact column list (so no reason,
// note or text column can arrive with it) and every guard ON THIS TABLE
// (looked up by conrelid), each CHECK compared IN FULL against the text
// Postgres stores, the athlete foreign key by shape (restMarks.pg.test.ts).
const EXPECTED_CHECKS = {
  pilot_athlete_rest_marks_kind_check:
    "CHECK ((kind = ANY (ARRAY['rest'::text, 'away'::text])))",
  pilot_athlete_rest_marks_role_check:
    "CHECK ((marked_by_role = ANY (ARRAY['coach'::text, 'organization_admin'::text, 'admin'::text])))",
  pilot_athlete_rest_marks_range_check:
    'CHECK (((last_day >= first_day) AND ((last_day - first_day) <= 34)))',
  pilot_athlete_rest_marks_clear_check:
    'CHECK (((cleared_at IS NULL) = (cleared_by_account_id IS NULL)))',
};

export const EXPECTED_COLUMNS = [
  'organization_id',
  'mark_id',
  'athlete_id',
  'kind',
  'first_day',
  'last_day',
  'marked_by_account_id',
  'marked_by_role',
  'marked_at',
  'cleared_at',
  'cleared_by_account_id',
];

const READINESS_QUERY = `
  select
    to_regclass('pilot.athlete_rest_marks') is not null as athlete_rest_marks_ready,
    (
      select array_agg(column_name::text order by ordinal_position)
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'athlete_rest_marks'
    ) = $4::text[] as columns_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot' and tablename = 'athlete_rest_marks'
        and indexname = 'idx_athlete_rest_marks_athlete_days'
        and indexdef like '%(organization_id, athlete_id, first_day, last_day) WHERE (cleared_at IS NULL)'
    ) as athlete_days_index_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot' and tablename = 'athlete_rest_marks'
        and indexname = 'uq_athlete_rest_marks_live_range'
        and indexdef like 'CREATE UNIQUE INDEX %(organization_id, athlete_id, kind, first_day, last_day) WHERE (cleared_at IS NULL)'
    ) as live_range_unique_ready,
    (
      select count(*) = $1 from pg_constraint c
      join unnest($2::text[], $3::text[]) as expected(conname, condef) on expected.conname = c.conname
      where c.conrelid = to_regclass('pilot.athlete_rest_marks')
        and c.contype = 'c' and c.convalidated
        and pg_get_constraintdef(c.oid) = expected.condef
    ) as checks_ready,
    exists (
      select 1 from pg_constraint c
      where c.conname = 'pilot_athlete_rest_marks_athlete_fk'
        and c.conrelid = to_regclass('pilot.athlete_rest_marks') and c.contype = 'f' and c.convalidated
        and c.confrelid = to_regclass('pilot.athletes') and c.confdeltype = 'c'
        and (select array_agg(a.attname::text order by k.ord)
               from unnest(c.conkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum)
            = array['organization_id', 'athlete_id']
        and (select array_agg(a.attname::text order by k.ord)
               from unnest(c.confkey) with ordinality k(attnum, ord)
               join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum)
            = array['organization_id', 'athlete_id']
    ) as athlete_fk_ready
`;
const READINESS_PARAMS = [
  Object.keys(EXPECTED_CHECKS).length,
  Object.keys(EXPECTED_CHECKS),
  Object.values(EXPECTED_CHECKS),
  EXPECTED_COLUMNS,
];

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY, READINESS_PARAMS);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error('ATHLETE_REST_MARKS_TABLE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_athlete_rest_marks_migration.sql',
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
  console.log(`Applied athlete rest marks migration: ${migrationPath}`);
  console.log('PILOT ATHLETE REST MARKS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ATHLETE REST MARKS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
