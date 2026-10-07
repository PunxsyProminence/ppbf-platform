import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the athlete-minor-limits migration inside one transaction. The
// operator names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Asserts the table, its read index and every guard ON THIS TABLE (looked up
// by conrelid, not by name alone), so an environment where the table exists
// without one of its checks or its athlete foreign key cannot pass readiness.
// Every CHECK is compared IN FULL against the text Postgres stores for it, so
// a looser predicate that happens to contain the right words fails; the
// foreign key is checked by shape (both column lists, target, ON DELETE
// CASCADE); each clause is refused on its own (athleteMinorLimits.pg.test.ts).
const EXPECTED_CHECKS = {
  pilot_athlete_minor_limits_type_check:
    "CHECK ((limit_type = ANY (ARRAY['heat_exposure_minutes_per_session'::text, 'weight_cut_max_percent_body_weight'::text, 'supervision'::text])))",
  pilot_athlete_minor_limits_number_check:
    "CHECK (((value_number IS NULL) OR ((value_number >= (0)::numeric) AND (value_number <> 'NaN'::numeric))))",
  pilot_athlete_minor_limits_text_check:
    "CHECK (((value_text IS NULL) OR ((length(btrim(value_text, ' \t\r\n'::text)) > 0) AND (length(value_text) <= 500))))",
  pilot_athlete_minor_limits_unit_check:
    "CHECK ((unit = ANY (ARRAY['minutes'::text, 'percent_body_weight'::text, 'text'::text])))",
  pilot_athlete_minor_limits_note_check: 'CHECK ((length(note) <= 1000))',
  pilot_athlete_minor_limits_role_check:
    "CHECK ((set_by_role = ANY (ARRAY['coach'::text, 'organization_admin'::text, 'admin'::text])))",
  pilot_athlete_minor_limits_shape_check:
    "CHECK ((((limit_type = 'heat_exposure_minutes_per_session'::text) AND (unit = 'minutes'::text) AND (value_text IS NULL))"
    + " OR ((limit_type = 'weight_cut_max_percent_body_weight'::text) AND (unit = 'percent_body_weight'::text) AND (value_text IS NULL)"
    + " AND ((value_number IS NULL) OR (value_number <= (100)::numeric)))"
    + " OR ((limit_type = 'supervision'::text) AND (unit = 'text'::text) AND (value_number IS NULL))))",
};

const READINESS_QUERY = `
  select
    to_regclass('pilot.athlete_minor_limits') is not null as athlete_minor_limits_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot' and tablename = 'athlete_minor_limits'
        and indexname = 'idx_athlete_minor_limits_athlete_type_seq'
        and indexdef like '%(organization_id, athlete_id, limit_type, limit_seq DESC)'
    ) as athlete_type_seq_index_ready,
    (
      select count(*) = $1 from pg_constraint c
      join unnest($2::text[], $3::text[]) as expected(conname, condef) on expected.conname = c.conname
      where c.conrelid = to_regclass('pilot.athlete_minor_limits')
        and c.contype = 'c' and c.convalidated
        and pg_get_constraintdef(c.oid) = expected.condef
    ) as checks_ready,
    exists (
      select 1 from pg_constraint c
      where c.conname = 'pilot_athlete_minor_limits_athlete_fk'
        and c.conrelid = to_regclass('pilot.athlete_minor_limits') and c.contype = 'f' and c.convalidated
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
];

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY, READINESS_PARAMS);
    const row = readiness.rows[0];
    if (!row || Object.values(row).some((value) => value !== true)) {
      throw new Error('ATHLETE_MINOR_LIMITS_TABLE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_athlete_minor_limits_migration.sql',
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
  console.log(`Applied athlete minor limits migration: ${migrationPath}`);
  console.log('PILOT ATHLETE MINOR LIMITS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ATHLETE MINOR LIMITS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
