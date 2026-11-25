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
// pilot.athlete_reached_out_marks and reported by name: the table; the exact
// column list; each column by type, nullability and default; exactly two
// CHECKs, validated and compared IN FULL against the text Postgres stores; the
// primary key on (organization_id, mark_id), not deferrable; exactly one other
// unique index, the current-mark index on (organization_id, athlete_id) WHERE
// cleared_at IS NULL, by columns (an expression column reads 0 there, so it
// never matches), their collations, validity and immediacy, and no unique or
// exclusion constraint; exactly four foreign keys, each by source columns,
// target table and columns, ON DELETE, ON UPDATE NO ACTION, validated and not
// deferrable; the guard trigger by name, BEFORE INSERT, UPDATE and DELETE, FOR
// EACH ROW, enabled, calling the guard function (whose body each apply
// replaces). Each condition is drifted on its own in
// reachedOutMarksMigration.pg.test.ts.
const EXPECTED_CHECKS = {
  pilot_athlete_reached_out_marks_role_check:
    "CHECK ((marked_by_role = ANY (ARRAY['coach'::text, 'organization_admin'::text, 'admin'::text])))",
  pilot_athlete_reached_out_marks_clear_check:
    'CHECK (((cleared_by_account_id IS NULL) OR (cleared_at IS NOT NULL)))',
};

export const EXPECTED_COLUMNS = [
  'organization_id',
  'mark_id',
  'athlete_id',
  'marked_by_account_id',
  'marked_by_role',
  'marked_at',
  'cleared_at',
  'cleared_by_account_id',
];

const OWN = 'pilot.athlete_reached_out_marks';
const attnum = (table, column) => `(select attnum from pg_attribute where attrelid = to_regclass('${table}') and attname = '${column}')`;
const attnums = (table, columns) => `array[${columns.map((column) => attnum(table, column)).join(', ')}]::int2[]`;
const attcollations = (table, columns) =>
  `array[${columns.map((column) => `(select attcollation from pg_attribute where attrelid = to_regclass('${table}') and attname = '${column}')`).join(', ')}]::oid[]`;
// type: a regtype; notNull: boolean; defaultText: what pg_get_expr prints, or null.
const column = (name, type, notNull, defaultText = null) => `
    exists (select 1 from col where attname = '${name}' and atttypid = '${type}'::regtype
              and ${notNull ? '' : 'not '}attnotnull
              and default_text ${defaultText === null ? 'is null' : `= '${defaultText}'`}) as ${name}_ready`;
// onDelete: pg_constraint.confdeltype ('c' cascade, 'n' set null).
const foreignKey = (name, columns, target, targetColumns, onDelete) => `
    exists (
      select 1 from con c where c.contype = 'f' and c.convalidated
        and c.confrelid = to_regclass('${target}')
        and c.confdeltype = '${onDelete}' and c.confupdtype = 'a' and not c.condeferrable
        and c.conkey = ${attnums(OWN, columns)}
        and c.confkey = ${attnums(target, targetColumns)}
    ) as ${name}_fk_ready`;

const READINESS_QUERY = `
  with t as (select to_regclass('${OWN}') as oid),
  col as (
    select a.attname, a.atttypid, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) as default_text
      from pg_attribute a
      join t on a.attrelid = t.oid
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attnum > 0 and not a.attisdropped
  ),
  con as (select c.* from pg_constraint c, t where c.conrelid = t.oid),
  uniq as (select i.* from pg_index i, t where i.indrelid = t.oid and i.indisunique and not i.indisprimary)
  select
    (select oid from t) is not null as table_ready,
    (
      select array_agg(column_name::text order by ordinal_position)
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'athlete_reached_out_marks'
    ) = $3::text[] as columns_ready,
    ${column('organization_id', 'text', true)},
    ${column('mark_id', 'uuid', true)},
    ${column('athlete_id', 'text', true)},
    ${column('marked_by_account_id', 'text', false)},
    ${column('marked_by_role', 'text', true)},
    ${column('marked_at', 'timestamptz', true, 'clock_timestamp()')},
    ${column('cleared_at', 'timestamptz', false)},
    ${column('cleared_by_account_id', 'text', false)},
    (select count(*) from con where contype = 'c') = $4
      and (
        select count(*) from con
        join unnest($1::text[], $2::text[]) as expected(conname, condef) on expected.conname = con.conname
        where con.contype = 'c' and con.convalidated and pg_get_constraintdef(con.oid) = expected.condef
      ) = $4 as checks_ready,
    exists (
      select 1 from con c where c.contype = 'p' and not c.condeferrable
        and c.conkey = ${attnums(OWN, ['organization_id', 'mark_id'])}
    ) as primary_key_ready,
    (select count(*) from uniq) = 1
      and exists (
        select 1 from uniq u where u.indisvalid and u.indimmediate
          -- indkey and indcollation are vectors numbered from 0; their text forms compare cleanly.
          and string_to_array(u.indkey::text, ' ')::int2[] = ${attnums(OWN, ['organization_id', 'athlete_id'])}
          and string_to_array(u.indcollation::text, ' ')::oid[] = ${attcollations(OWN, ['organization_id', 'athlete_id'])}
          and pg_get_expr(u.indpred, u.indrelid) = '(cleared_at IS NULL)'
      ) as current_mark_index_ready,
    not exists (select 1 from con where contype in ('u', 'x')) as no_unique_constraint_ready,
    (select count(*) from con where contype = 'f') = 4 as foreign_key_count_ready,
    ${foreignKey('organization', ['organization_id'], 'pilot.organizations', ['organization_id'], 'c')},
    ${foreignKey('athlete', ['organization_id', 'athlete_id'], 'pilot.athletes', ['organization_id', 'athlete_id'], 'c')},
    ${foreignKey('marked_by', ['marked_by_account_id'], 'pilot.accounts', ['account_id'], 'n')},
    ${foreignKey('cleared_by', ['cleared_by_account_id'], 'pilot.accounts', ['account_id'], 'n')},
    -- tgtype: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16.
    exists (
      select 1 from pg_trigger g
       where g.tgrelid = to_regclass('${OWN}') and g.tgname = 'trg_athlete_reached_out_marks_guard' and not g.tgisinternal
         and g.tgenabled in ('O', 'A') and (g.tgtype & 31) = 31
         and g.tgfoid = to_regprocedure('pilot.athlete_reached_out_marks_guard()')
    ) as guard_ready
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
    // Creating the four foreign keys takes a SHARE ROW EXCLUSIVE lock on
    // pilot.organizations, pilot.athletes and pilot.accounts (reads go on,
    // writes wait). Rather than queue behind a long transaction already
    // holding one, and hold every write to those tables up behind it, give up
    // after 10 seconds and let the operator re-run in a quieter moment.
    // Nothing is half-applied.
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
