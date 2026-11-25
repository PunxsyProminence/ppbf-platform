import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the athlete-reached-out-marks migration (lane W4-6, SC-3a-1;
// OW27-33 B: the stopped-coming page gets a "reached out" mark; Overwatch W4-6
// Q4 A: who and when only, one current mark per athlete, a take-back keeps the
// row) inside one transaction. The operator names the host and database they
// believe they are pointing at (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a
// mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Readiness asserts the result, not the attempt, each piece looked up ON
// pilot.athlete_reached_out_marks and reported by name: the exact column list;
// each column by type, nullability and default; exactly two CHECKs, validated
// and compared IN FULL against the text Postgres stores; the primary key on
// (organization_id, athlete_id); no other unique constraint or unique index;
// exactly two foreign keys, each by column, target table and column, ON DELETE
// CASCADE, ON UPDATE NO ACTION and not deferrable. Each is refused on its own
// (reachedOutMarksMigration.pg.test.ts), except the target COLUMNS of each
// foreign key, which no test drifts: neither target has a second unique key of
// the same shape to point one at.
const EXPECTED_CHECKS = {
  pilot_athlete_reached_out_marks_role_check:
    "CHECK ((marked_by_role = ANY (ARRAY['coach'::text, 'organization_admin'::text, 'admin'::text])))",
  pilot_athlete_reached_out_marks_clear_check:
    'CHECK (((cleared_at IS NULL) = (cleared_by_account_id IS NULL)))',
};

export const EXPECTED_COLUMNS = [
  'organization_id',
  'athlete_id',
  'marked_by_account_id',
  'marked_by_role',
  'marked_at',
  'cleared_at',
  'cleared_by_account_id',
];

const attnum = (table, column) => `(select attnum from pg_attribute where attrelid = to_regclass('${table}') and attname = '${column}')`;
const OWN = 'pilot.athlete_reached_out_marks';

const READINESS_QUERY = `
  with t as (select to_regclass('${OWN}') as oid),
  col as (
    select a.attname, a.atttypid, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) as default_text
      from pg_attribute a
      join t on a.attrelid = t.oid
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attnum > 0 and not a.attisdropped
  ),
  con as (select c.* from pg_constraint c, t where c.conrelid = t.oid)
  select
    (select oid from t) is not null as table_ready,
    (
      select array_agg(column_name::text order by ordinal_position)
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'athlete_reached_out_marks'
    ) = $3::text[] as columns_ready,
    exists (select 1 from col where attname = 'organization_id'
              and atttypid = 'text'::regtype and attnotnull and default_text is null) as organization_id_ready,
    exists (select 1 from col where attname = 'athlete_id'
              and atttypid = 'text'::regtype and attnotnull and default_text is null) as athlete_id_ready,
    exists (select 1 from col where attname = 'marked_by_account_id'
              and atttypid = 'text'::regtype and attnotnull and default_text is null) as marked_by_account_id_ready,
    exists (select 1 from col where attname = 'marked_by_role'
              and atttypid = 'text'::regtype and attnotnull and default_text is null) as marked_by_role_ready,
    exists (select 1 from col where attname = 'marked_at'
              and atttypid = 'timestamptz'::regtype and attnotnull and default_text = 'clock_timestamp()') as marked_at_ready,
    exists (select 1 from col where attname = 'cleared_at'
              and atttypid = 'timestamptz'::regtype and not attnotnull and default_text is null) as cleared_at_ready,
    exists (select 1 from col where attname = 'cleared_by_account_id'
              and atttypid = 'text'::regtype and not attnotnull and default_text is null) as cleared_by_account_id_ready,
    (select count(*) from con where contype = 'c') = $4
      and (
        select count(*) from con
        join unnest($1::text[], $2::text[]) as expected(conname, condef) on expected.conname = con.conname
        where con.contype = 'c' and con.convalidated and pg_get_constraintdef(con.oid) = expected.condef
      ) = $4 as checks_ready,
    exists (
      select 1 from con c where c.contype = 'p'
        and c.conkey = array[${attnum(OWN, 'organization_id')}, ${attnum(OWN, 'athlete_id')}]::int2[]
    ) as primary_key_ready,
    not exists (select 1 from con where contype in ('u', 'x'))
      and not exists (select 1 from pg_index i, t where i.indrelid = t.oid and i.indisunique and not i.indisprimary)
      as no_other_unique_ready,
    (select count(*) from con where contype = 'f') = 2 as foreign_key_count_ready,
    exists (
      select 1 from con c where c.contype = 'f' and c.convalidated
        and c.confrelid = to_regclass('pilot.organizations')
        and c.confdeltype = 'c' and c.confupdtype = 'a' and not c.condeferrable
        and c.conkey = array[${attnum(OWN, 'organization_id')}]::int2[]
        and c.confkey = array[${attnum('pilot.organizations', 'organization_id')}]::int2[]
    ) as organization_fk_ready,
    exists (
      select 1 from con c where c.contype = 'f' and c.convalidated
        and c.confrelid = to_regclass('pilot.athletes')
        and c.confdeltype = 'c' and c.confupdtype = 'a' and not c.condeferrable
        and c.conkey = array[${attnum(OWN, 'organization_id')}, ${attnum(OWN, 'athlete_id')}]::int2[]
        and c.confkey = array[${attnum('pilot.athletes', 'organization_id')}, ${attnum('pilot.athletes', 'athlete_id')}]::int2[]
    ) as athlete_fk_ready
`;
const READINESS_PARAMS = [
  Object.keys(EXPECTED_CHECKS),
  Object.values(EXPECTED_CHECKS),
  EXPECTED_COLUMNS,
  Object.keys(EXPECTED_CHECKS).length,
];

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    // Creating the two foreign keys takes a SHARE ROW EXCLUSIVE lock on
    // pilot.organizations and pilot.athletes (reads go on, writes wait). Rather
    // than queue behind a long transaction already holding one, and hold every
    // write to those tables up behind it, give up after 10 seconds and let the
    // operator re-run in a quieter moment. Nothing is half-applied.
    await client.query("set local lock_timeout = '10s'");
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY, READINESS_PARAMS);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`ATHLETE_REACHED_OUT_MARKS_TABLE_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_athlete_reached_out_marks_migration.sql',
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
  console.log(`Applied athlete reached-out marks migration: ${migrationPath}`);
  console.log('PILOT ATHLETE REACHED OUT MARKS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ATHLETE REACHED OUT MARKS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
