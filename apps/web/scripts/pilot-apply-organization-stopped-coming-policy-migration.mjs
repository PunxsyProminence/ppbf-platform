import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the organization-stopped-coming-policy migration (lane W4-6, SC-0a;
// OW27-30 A: the gym admin sets how many days without a present mark put an
// athlete on the "who has stopped coming" list, first value 2 weeks) inside
// one transaction. The operator names the host and database they believe they
// are pointing at (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch
// refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Readiness asserts the result, not the attempt (the #2135 runner's shape),
// each piece looked up ON pilot.organization_stopped_coming_policy and
// reported by name: the exact column list; each column by type, nullability
// and default; exactly one CHECK, validated and compared IN FULL against the
// text Postgres stores; the primary key on organization_id alone; no other
// unique constraint or unique index; exactly two foreign keys, each by column,
// target table and column, ON DELETE (cascade for the gym, set null for the
// setter), ON UPDATE NO ACTION and not deferrable. Each is refused on its own
// (stoppedComingPolicyMigration.pg.test.ts), except the target COLUMN of each
// foreign key, which no test drifts: neither target table has a second unique
// column to point a foreign key at.
const EXPECTED_CHECK_NAME = 'pilot_org_stopped_coming_gap_days_check';
const EXPECTED_CHECK = 'CHECK ((gap_days = ANY (ARRAY[7, 14, 21, 28, 42, 56])))';

export const EXPECTED_COLUMNS = [
  'organization_id',
  'gap_days',
  'set_by_account_id',
  'set_at',
];

const READINESS_QUERY = `
  with t as (select to_regclass('pilot.organization_stopped_coming_policy') as oid),
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
      where table_schema = 'pilot' and table_name = 'organization_stopped_coming_policy'
    ) = $3::text[] as columns_ready,
    exists (select 1 from col where attname = 'organization_id'
              and atttypid = 'text'::regtype and attnotnull and default_text is null) as organization_id_ready,
    exists (select 1 from col where attname = 'gap_days'
              and atttypid = 'integer'::regtype and attnotnull and default_text is null) as gap_days_ready,
    exists (select 1 from col where attname = 'set_by_account_id'
              and atttypid = 'text'::regtype and not attnotnull and default_text is null) as set_by_account_id_ready,
    exists (select 1 from col where attname = 'set_at'
              and atttypid = 'timestamptz'::regtype and attnotnull and default_text = 'clock_timestamp()') as set_at_ready,
    (select count(*) from con where contype = 'c') = 1
      and exists (select 1 from con where conname = $1 and contype = 'c' and convalidated
                    and pg_get_constraintdef(oid) = $2) as check_ready,
    exists (
      select 1 from con c, t where c.contype = 'p'
        and c.conkey = array[(select attnum from pg_attribute where attrelid = t.oid and attname = 'organization_id')]::int2[]
    ) as primary_key_ready,
    not exists (select 1 from con where contype in ('u', 'x'))
      and not exists (select 1 from pg_index i, t where i.indrelid = t.oid and i.indisunique and not i.indisprimary)
      as no_other_unique_ready,
    (select count(*) from con where contype = 'f') = 2 as foreign_key_count_ready,
    exists (
      select 1 from con c, t where c.contype = 'f' and c.convalidated
        and c.confrelid = to_regclass('pilot.organizations')
        and c.confdeltype = 'c' and c.confupdtype = 'a' and not c.condeferrable
        and c.conkey = array[(select attnum from pg_attribute where attrelid = t.oid and attname = 'organization_id')]::int2[]
        and c.confkey = array[(select attnum from pg_attribute where attrelid = to_regclass('pilot.organizations') and attname = 'organization_id')]::int2[]
    ) as organization_fk_ready,
    exists (
      select 1 from con c, t where c.contype = 'f' and c.convalidated
        and c.confrelid = to_regclass('pilot.accounts')
        and c.confdeltype = 'n' and c.confupdtype = 'a' and not c.condeferrable
        and c.conkey = array[(select attnum from pg_attribute where attrelid = t.oid and attname = 'set_by_account_id')]::int2[]
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
    const readiness = await client.query(READINESS_QUERY, [EXPECTED_CHECK_NAME, EXPECTED_CHECK, EXPECTED_COLUMNS]);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`ORGANIZATION_STOPPED_COMING_POLICY_TABLE_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_organization_stopped_coming_policy_migration.sql',
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
  console.log(`Applied organization stopped-coming policy migration: ${migrationPath}`);
  console.log('PILOT ORGANIZATION STOPPED COMING POLICY MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ORGANIZATION STOPPED COMING POLICY MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
