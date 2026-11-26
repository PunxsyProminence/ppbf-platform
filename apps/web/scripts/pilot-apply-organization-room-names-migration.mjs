import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the organization-room-names migration (lane W4-9, RN-1a; OW27-11 and
// OW27-40 A: a gym renames its rooms and a few card headings) inside one
// transaction. The operator names the host and database they believe they are
// pointing at (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses
// before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Readiness asserts the result, not the attempt (the stopped-coming runner's
// shape), each piece looked up ON pilot.organization_room_names and reported
// by name: an ordinary, logged table; the exact column list; each column by
// type, nullability and default; exactly two CHECKs, each validated and
// compared IN FULL against the text Postgres stores; the primary key on
// (organization_id, name_key) in that order and not deferrable (RN-1b's save
// is an ON CONFLICT on it, which a deferrable key cannot serve); no other
// unique constraint or unique index; exactly two foreign keys, each by local
// column, target table and column, validated, ON DELETE (cascade for the gym,
// set null for the setter), ON UPDATE NO ACTION and not deferrable.
// organizationRoomNamesMigration.pg.test.ts refuses each piece on its own,
// with three exceptions it does not drift separately:
// - a CHECK's validated flag: a NOT VALID CHECK already fails the full-text
//   comparison (INFERRED: Postgres reports it with " NOT VALID");
// - the constraint-type half of the uniqueness check: a unique or exclusion
//   constraint also creates the unique index the other half sees;
// - the target COLUMN of each foreign key: neither target table has a second
//   unique column to point a foreign key at.

// The whitespace JavaScript's trim() removes, as a Postgres regex class (the
// same class as source_rights_migration.sql and locatorWhitespace.ts), and the
// control characters and line breaks Q-C refuses, both as code points.
const TRIM_CLASS = String.raw` \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff`;
const CONTROL_CLASS = String.raw`\u0001-\u001f\u007f-\u009f\u2028\u2029`;

export const EXPECTED_CHECKS = [
  ['pilot_org_room_names_key_check', "CHECK ((name_key ~ '^(place|room|card):[a-z]+(-[a-z]+)*$'::text))"],
  [
    'pilot_org_room_names_display_name_check',
    'CHECK ((((char_length(display_name) >= 1) AND (char_length(display_name) <= 40))'
      + ` AND (display_name !~ '^[${TRIM_CLASS}]'::text)`
      + ` AND (display_name !~ '[${TRIM_CLASS}]$'::text)`
      + ` AND (display_name !~ '[${CONTROL_CLASS}]'::text)))`,
  ],
];

export const EXPECTED_COLUMNS = [
  'organization_id',
  'name_key',
  'display_name',
  'set_by_account_id',
  'set_at',
];

const READINESS_QUERY = `
  with t as (select to_regclass('pilot.organization_room_names') as oid),
  col as (
    select a.attname, a.atttypid, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) as default_text
      from pg_attribute a
      join t on a.attrelid = t.oid
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
     where a.attnum > 0 and not a.attisdropped
  ),
  con as (select c.* from pg_constraint c, t where c.conrelid = t.oid),
  attnum_of as (
    select a.attname, a.attnum from pg_attribute a, t where a.attrelid = t.oid
  )
  select
    (select oid from t) is not null as table_ready,
    exists (select 1 from pg_class c, t where c.oid = t.oid and c.relkind = 'r' and c.relpersistence = 'p')
      as table_kind_ready,
    (
      select array_agg(column_name::text order by ordinal_position)
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'organization_room_names'
    ) = $5::text[] as columns_ready,
    exists (select 1 from col where attname = 'organization_id'
              and atttypid = 'text'::regtype and attnotnull and default_text is null) as organization_id_ready,
    exists (select 1 from col where attname = 'name_key'
              and atttypid = 'text'::regtype and attnotnull and default_text is null) as name_key_ready,
    exists (select 1 from col where attname = 'display_name'
              and atttypid = 'text'::regtype and attnotnull and default_text is null) as display_name_ready,
    exists (select 1 from col where attname = 'set_by_account_id'
              and atttypid = 'text'::regtype and not attnotnull and default_text is null) as set_by_account_id_ready,
    exists (select 1 from col where attname = 'set_at'
              and atttypid = 'timestamptz'::regtype and attnotnull and default_text = 'clock_timestamp()') as set_at_ready,
    (select count(*) from con where contype = 'c') = 2 as check_count_ready,
    exists (select 1 from con where conname = $1 and contype = 'c' and convalidated
              and pg_get_constraintdef(oid) = $2) as key_check_ready,
    exists (select 1 from con where conname = $3 and contype = 'c' and convalidated
              and pg_get_constraintdef(oid) = $4) as display_name_check_ready,
    exists (
      select 1 from con c where c.contype = 'p' and not c.condeferrable
        and c.conkey = array[
          (select attnum from attnum_of where attname = 'organization_id'),
          (select attnum from attnum_of where attname = 'name_key')
        ]::int2[]
    ) as primary_key_ready,
    not exists (select 1 from con where contype in ('u', 'x'))
      and not exists (select 1 from pg_index i, t where i.indrelid = t.oid and i.indisunique and not i.indisprimary)
      as no_other_unique_ready,
    (select count(*) from con where contype = 'f') = 2 as foreign_key_count_ready,
    exists (
      select 1 from con c where c.contype = 'f' and c.convalidated
        and c.confrelid = to_regclass('pilot.organizations')
        and c.confdeltype = 'c' and c.confupdtype = 'a' and not c.condeferrable
        and c.conkey = array[(select attnum from attnum_of where attname = 'organization_id')]::int2[]
        and c.confkey = array[(select attnum from pg_attribute where attrelid = to_regclass('pilot.organizations') and attname = 'organization_id')]::int2[]
    ) as organization_fk_ready,
    exists (
      select 1 from con c where c.contype = 'f' and c.convalidated
        and c.confrelid = to_regclass('pilot.accounts')
        and c.confdeltype = 'n' and c.confupdtype = 'a' and not c.condeferrable
        and c.conkey = array[(select attnum from attnum_of where attname = 'set_by_account_id')]::int2[]
        and c.confkey = array[(select attnum from pg_attribute where attrelid = to_regclass('pilot.accounts') and attname = 'account_id')]::int2[]
    ) as set_by_fk_ready
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    // Creating the table's two foreign keys takes a SHARE ROW EXCLUSIVE lock
    // on pilot.organizations and pilot.accounts (reads go on, writes wait).
    // Rather than queue behind a long transaction already holding one, and
    // hold every write to those tables up behind it, give up after 10 seconds
    // and let the operator re-run in a quieter moment. Nothing is
    // half-applied: it is one transaction.
    await client.query("set local lock_timeout = '10s'");
    await client.query(sql);
    const [[keyCheckName, keyCheck], [displayCheckName, displayCheck]] = EXPECTED_CHECKS;
    const readiness = await client.query(READINESS_QUERY, [
      keyCheckName,
      keyCheck,
      displayCheckName,
      displayCheck,
      EXPECTED_COLUMNS,
    ]);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`ORGANIZATION_ROOM_NAMES_TABLE_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_organization_room_names_migration.sql',
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
  console.log(`Applied organization room names migration: ${migrationPath}`);
  console.log('PILOT ORGANIZATION ROOM NAMES MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ORGANIZATION ROOM NAMES MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
