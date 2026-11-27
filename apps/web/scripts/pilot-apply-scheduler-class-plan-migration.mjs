import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the scheduler-class-plan migration (lane W4-5, SP-3: a scheduled class names the session
// plan it runs) inside one transaction. The operator names the host and database they believe they
// are pointing at (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before
// connecting. Shaped as pilot-apply-session-run-class-migration.mjs.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

const CLASSES = `to_regclass('pilot.scheduler_classes')`;

/** The names of the columns in `keys` (conkey, confkey or confdelsetcols) of table `rel`, IN KEY ORDER. */
function keyColumns(keys, rel) {
  return `(
    select array_agg(a.attname::text order by k.ord)
      from unnest(${keys}) with ordinality as k(attnum, ord)
      join pg_attribute a on a.attrelid = ${rel} and a.attnum = k.attnum
  )`;
}

function textArray(values) {
  return `array[${values.map((value) => `'${value}'`).join(', ')}]::text[]`;
}

// One column of `table`, exactly: its type, nullable, and with no default (a default would stamp
// every existing and every new class with a plan nobody chose).
function nullableColumn(table, name, type) {
  return `exists (
    select 1 from pg_attribute a
     where a.attrelid = ${table} and a.attname = '${name}' and not a.attisdropped
       and format_type(a.atttypid, a.atttypmod) = '${type}' and not a.attnotnull and not a.atthasdef
  )`;
}

// A VALIDATED foreign key on `table` with this name, read from the catalog rather than from its
// printed text (which changes with the session's search_path): its own columns and the columns
// it points at, each in key order, so a permuted or cross-wired key does not pass; its target
// table; and that a delete of the target sets ONLY `setNullColumn` to null ('n' with that one
// column in confdelsetcols). The whole-key form ('n' with no column list) would null
// organization_id too and fail at delete time; cascade would delete the class.
function setNullForeignKey(table, name, columns, target, targetColumns, setNullColumn) {
  return `exists (
    select 1 from pg_constraint c
     where c.conrelid = ${table} and c.conname = '${name}' and c.contype = 'f' and c.convalidated
       and c.confrelid = to_regclass('${target}') and c.confdeltype = 'n'
       and ${keyColumns('c.conkey', 'c.conrelid')} = ${textArray(columns)}
       and ${keyColumns('c.confkey', 'c.confrelid')} = ${textArray(targetColumns)}
       and ${keyColumns('c.confdelsetcols', 'c.conrelid')} = ${textArray([setNullColumn])}
  )`;
}

// A valid btree index on `table` by name: unique or not as stated, its columns in order, no
// expressions, and its predicate exactly (so one widened to every class, or narrowed to fewer, is
// refused).
function index(name, table, { unique, columns, predicate }) {
  return `exists (
    select 1 from pg_index i
     where i.indexrelid = to_regclass('pilot.${name}') and i.indrelid = ${table}
       and i.indisvalid and i.indisunique = ${unique ? 'true' : 'false'} and i.indexprs is null
       and (
         select array_agg(a.attname::text order by k.ord)
           from unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
       ) = ${textArray(columns)}
       and coalesce(pg_get_expr(i.indpred, i.indrelid), '') = '${predicate.replace(/'/g, "''")}'
  )`;
}

// Readiness asserts the result, not the attempt: every rule the migration creates is read back
// from the catalog, and a database that is missing one, or holds a looser one, is refused.
const READINESS_QUERY = `
  select
    ${nullableColumn(CLASSES, 'script_id', 'text')} as class_plan_column_ready,
    ${setNullForeignKey(CLASSES, 'pilot_scheduler_classes_script_fk', ['organization_id', 'script_id'],
      'pilot.session_scripts', ['organization_id', 'script_id'], 'script_id')} as class_plan_fk_ready,
    ${index('pilot_scheduler_classes_script', CLASSES, {
      unique: false,
      columns: ['organization_id', 'script_id'],
      predicate: '(script_id IS NOT NULL)',
    })} as class_plan_index_ready
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    // The first apply takes an exclusive lock on the class table (the new column), and the
    // foreign key takes SHARE ROW EXCLUSIVE on the plan table, which blocks plan writes until
    // this commits. Rather than queue those behind a long
    // transaction already holding one of them, give up and let the operator re-run in a quieter
    // moment. Nothing is half-applied: it is one transaction. (A re-run of an applied migration
    // reads the catalog and takes none of these locks.) The same reasoning as
    // pilot-apply-session-run-class-migration.mjs.
    await client.query("set local lock_timeout = '10s'");
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`SCHEDULER_CLASS_PLAN_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_scheduler_class_plan_migration.sql',
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
  console.log(`Applied scheduler class plan migration: ${migrationPath}`);
  console.log('PILOT SCHEDULER CLASS PLAN MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SCHEDULER CLASS PLAN MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
