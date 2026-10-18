import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the athlete-metrics migration (lane L60: the enjoyment tap and the coach-entered
// standing height) inside one transaction. The operator names the host and database they believe
// they are pointing at (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// Collapses runs of whitespace, so a check is compared with the exact predicate PostgreSQL prints
// for this migration's own text. Matching only a few words passed a same-named check widened by
// an OR in an earlier suite (family_reply_reads); the whole predicate is the test.
const CHECK_DEF = `regexp_replace(pg_get_constraintdef(c.oid), '[[:space:]]+', ' ', 'g')`;

function namedCheck(table, name, definition) {
  return `exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('${table}') and c.contype = 'c' and c.convalidated
         and c.conname = '${name}'
         and ${CHECK_DEF} = '${definition.replace(/'/g, "''")}'
    )`;
}

function keyColumns(table, name, type, columns) {
  return `exists (
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('${table}') and c.conname = '${name}' and c.contype = '${type}'
         and (
           select array_agg(a.attname::text order by a.attname)
             from pg_attribute a
            where a.attrelid = c.conrelid and a.attnum = any (c.conkey)
         ) = array[${[...columns].sort().map((column) => `'${column}'`).join(', ')}]
    )`;
}

function column(table, name, type, notNull) {
  // The type exactly, the nullability exactly, and NO default: a default on enjoyment would
  // answer the question for every athlete who skipped it; one on a height column would invent a
  // reading.
  return `exists (
      select 1 from pg_attribute a
       where a.attrelid = to_regclass('${table}') and a.attname = '${name}' and not a.attisdropped
         and format_type(a.atttypid, a.atttypmod) = '${type}'
         and a.attnotnull = ${notNull ? 'true' : 'false'}
         and not a.atthasdef
    )`;
}

// Readiness asserts the result, not the attempt. Each object is looked up by name ON its own
// table, so a same-named object elsewhere does not pass.
const READINESS_QUERY = `
  select
    ${column('pilot.sessions', 'enjoyment', 'integer', false)} as enjoyment_column_ready,
    ${namedCheck('pilot.sessions', 'pilot_sessions_enjoyment_range',
      'CHECK (((enjoyment IS NULL) OR ((enjoyment >= 1) AND (enjoyment <= 5))))')} as enjoyment_range_ready,
    to_regclass('pilot.athlete_heights') is not null as heights_table_ready,
    ${column('pilot.athlete_heights', 'height_cm', 'numeric(4,1)', true)}
      and ${column('pilot.athlete_heights', 'measured_on', 'date', true)}
      and ${column('pilot.athlete_heights', 'athlete_id', 'text', true)}
      and ${column('pilot.athlete_heights', 'recorded_by_account_id', 'text', true)}
      and ${column('pilot.athlete_heights', 'recorded_by_role', 'text', true)}
      and ${column('pilot.athlete_heights', 'request_key', 'text', true)}
      and ${column('pilot.athlete_heights', 'supersedes_height_id', 'uuid', false)} as heights_columns_ready,
    ${keyColumns('pilot.athlete_heights', 'pilot_athlete_heights_pkey', 'p', ['organization_id', 'height_id'])}
      as primary_key_ready,
    ${keyColumns('pilot.athlete_heights', 'pilot_athlete_heights_request_key_unique', 'u', ['organization_id', 'request_key'])}
      as request_key_unique_ready,
    ${keyColumns('pilot.athlete_heights', 'pilot_athlete_heights_one_correction', 'u', ['organization_id', 'supersedes_height_id'])}
      as one_correction_ready,
    ${keyColumns('pilot.athlete_heights', 'pilot_athlete_heights_athlete_height_key', 'u', ['organization_id', 'athlete_id', 'height_id'])}
      as athlete_height_key_ready,
    ${namedCheck('pilot.athlete_heights', 'pilot_athlete_heights_not_self_check',
      'CHECK (((supersedes_height_id IS NULL) OR (supersedes_height_id <> height_id)))')}
      and ${namedCheck('pilot.athlete_heights', 'pilot_athlete_heights_request_key_check',
        'CHECK (((length(btrim(request_key)) >= 1) AND (length(btrim(request_key)) <= 200)))')}
      and ${namedCheck('pilot.athlete_heights', 'pilot_athlete_heights_measured_on_check',
        "CHECK ((measured_on >= '2000-01-01'::date))")} as shape_checks_ready,
    exists (
      -- Dies with its athlete: (organization_id, athlete_id) -> pilot.athletes, with the cascade.
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.athlete_heights')
         and c.conname = 'pilot_athlete_heights_athlete_fk' and c.contype = 'f'
         and c.confrelid = to_regclass('pilot.athletes') and c.confdeltype = 'c'
         and array(
           select a.attname::text from unnest(c.conkey) with ordinality k(attnum, n)
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum order by k.n
         ) = array['organization_id', 'athlete_id']
         and array(
           select a.attname::text from unnest(c.confkey) with ordinality k(attnum, n)
             join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum order by k.n
         ) = array['organization_id', 'athlete_id']
    ) as athlete_fk_ready,
    exists (
      -- A correction names a reading of the SAME athlete in the same gym: all three columns, in
      -- order, against (organization_id, athlete_id, height_id) on this table.
      select 1 from pg_constraint c
       where c.conrelid = to_regclass('pilot.athlete_heights')
         and c.conname = 'pilot_athlete_heights_supersedes_fk' and c.contype = 'f'
         and c.confrelid = to_regclass('pilot.athlete_heights') and c.confdeltype = 'c'
         and array_length(c.conkey, 1) = 3 and array_length(c.confkey, 1) = 3
         and array(
           select a.attname::text from unnest(c.conkey) with ordinality k(attnum, n)
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum order by k.n
         ) = array['organization_id', 'athlete_id', 'supersedes_height_id']
         and array(
           select a.attname::text from unnest(c.confkey) with ordinality k(attnum, n)
             join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.attnum order by k.n
         ) = array['organization_id', 'athlete_id', 'height_id']
    ) as supersedes_fk_ready,
    ${namedCheck('pilot.athlete_heights', 'pilot_athlete_heights_cm_range',
      'CHECK (((height_cm >= 50.0) AND (height_cm <= 250.0)))')} as cm_range_ready,
    ${namedCheck('pilot.athlete_heights', 'pilot_athlete_heights_role_check',
      "CHECK ((recorded_by_role = ANY (ARRAY['coach'::text, 'organization_admin'::text, 'admin'::text])))")}
      as role_check_ready,
    exists (
      -- BEFORE (bit 2), ROW (bit 1), on INSERT (bit 4), DELETE (bit 8) and UPDATE (bit 16),
      -- firing in ordinary sessions (O or A; R fires only under replication, D never), and
      -- calling this migration's function.
      select 1 from pg_trigger t
       where t.tgrelid = to_regclass('pilot.athlete_heights')
         and t.tgname = 'trg_athlete_heights_guard' and not t.tgisinternal
         and t.tgenabled in ('O', 'A')
         and (t.tgtype & 2) = 2 and (t.tgtype & 1) = 1
         and (t.tgtype & 4) = 4 and (t.tgtype & 8) = 8 and (t.tgtype & 16) = 16
         and t.tgfoid = to_regprocedure('pilot.athlete_heights_guard()')
    ) as guard_ready
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`ATHLETE_METRICS_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_athlete_metrics_migration.sql',
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
  console.log(`Applied athlete metrics migration: ${migrationPath}`);
  console.log('PILOT ATHLETE METRICS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ATHLETE METRICS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
