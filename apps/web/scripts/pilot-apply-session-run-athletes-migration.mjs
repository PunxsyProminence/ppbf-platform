import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the session-run-athletes migration (F-067) inside one transaction. The operator
// names the host and database they believe they are pointing at
// (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

const MARKS = `to_regclass('pilot.session_run_athletes')`;
const NOTES = `to_regclass('pilot.session_staff_notes')`;

/** The names of the columns in `keys` (conkey or confkey) of table `rel`, IN KEY ORDER. */
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

// A VALIDATED foreign key on `table`, read from the catalog rather than from its printed text
// (which changes with the session's search_path): its own columns and the columns it points at,
// each in key order, so a permuted or cross-wired key does not pass; its target table; and what
// a delete of the target does ('c' cascade, 'a' no action). Matched by shape, not by name, so
// the keys Postgres named itself are held to the same standard as the ones named here.
function foreignKey(table, columns, target, targetColumns, onDelete) {
  return `exists (
    select 1 from pg_constraint c
     where c.conrelid = ${table} and c.contype = 'f' and c.convalidated
       and c.confrelid = to_regclass('${target}') and c.confdeltype = '${onDelete}'
       and ${keyColumns('c.conkey', 'c.conrelid')} = ${textArray(columns)}
       and ${keyColumns('c.confkey', 'c.confrelid')} = ${textArray(targetColumns)}
  )`;
}

// A VALIDATED check whose own text is exactly `definition`. A check's text names no schema, so
// it does not move with search_path; and comparing the whole of it is what refuses a loosened
// check (a fourth role, "or true", ">=" for "=") that a pattern would let through.
function check(table, name, definition) {
  return `exists (
    select 1 from pg_constraint c
     where c.conrelid = ${table} and c.conname = '${name}' and c.contype = 'c' and c.convalidated
       and pg_get_constraintdef(c.oid) = '${definition.replace(/'/g, "''")}'
  )`;
}

// A valid, non-unique btree index on `table`: its columns in order, and its predicate (or none).
function index(name, table, columns, predicate) {
  return `exists (
    select 1 from pg_index i
     where i.indexrelid = to_regclass('pilot.${name}') and i.indrelid = ${table}
       and i.indisvalid and not i.indisunique and i.indexprs is null
       and (
         select array_agg(a.attname::text order by k.ord)
           from unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
       ) = ${textArray(columns)}
       and coalesce(pg_get_expr(i.indpred, i.indrelid), '') = '${predicate}'
  )`;
}

const MARK_COLUMNS = [
  'organization_id text not null',
  'run_id text not null',
  'athlete_id text not null',
  'marked_by_account_id text not null',
  'marked_by_role text not null',
  'marked_at timestamp with time zone not null',
  'removed_at timestamp with time zone',
  'removed_by_account_id text',
];
// Added by pilot_slice_postgres_session_run_class_migration.sql, which runs after this one.
const LATER_MARK_COLUMNS = ['register_class_id text', 'register_written_at timestamp with time zone'];

// Readiness asserts the result, not the attempt: every rule the migration creates is read back
// from the catalog, and a database that is missing one, or holds a looser one, is refused.
const READINESS_QUERY = `
  select
    ${MARKS} is not null as table_ready,
    -- Every column of the new table: name, type and whether it may be null, in order. Exactly
    -- these, or these followed by the two the session-run-class migration adds later
    -- (register_class_id, register_written_at, D4), because the \`all\` chain re-runs this runner
    -- on a database that has both.
    (
      select array_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end order by a.attnum)
        from pg_attribute a
       where a.attrelid = ${MARKS} and a.attnum > 0 and not a.attisdropped
    ) in (${textArray(MARK_COLUMNS)}, ${textArray([...MARK_COLUMNS, ...LATER_MARK_COLUMNS])}) as columns_ready,
    exists (
      select 1 from pg_constraint c
       where c.conrelid = ${MARKS} and c.conname = 'pilot_session_run_athletes_pkey' and c.contype = 'p'
         and ${keyColumns('c.conkey', 'c.conrelid')} = ${textArray(['organization_id', 'run_id', 'athlete_id'])}
    ) as primary_key_ready,
    ${foreignKey(MARKS, ['organization_id'], 'pilot.organizations', ['organization_id'], 'c')} as organization_fk_ready,
    ${foreignKey(MARKS, ['organization_id', 'run_id'], 'pilot.session_script_runs', ['organization_id', 'run_id'], 'c')} as run_fk_ready,
    ${foreignKey(MARKS, ['organization_id', 'athlete_id'], 'pilot.athletes', ['organization_id', 'athlete_id'], 'c')} as athlete_fk_ready,
    ${foreignKey(MARKS, ['marked_by_account_id'], 'pilot.accounts', ['account_id'], 'a')} as marked_by_fk_ready,
    ${foreignKey(MARKS, ['removed_by_account_id'], 'pilot.accounts', ['account_id'], 'a')} as removed_by_fk_ready,
    ${check(MARKS, 'pilot_session_run_athletes_role_check',
      "CHECK ((marked_by_role = ANY (ARRAY['coach'::text, 'organization_admin'::text, 'admin'::text])))")} as role_check_ready,
    ${check(MARKS, 'pilot_session_run_athletes_removed_pair',
      'CHECK (((removed_at IS NULL) = (removed_by_account_id IS NULL)))')} as removed_pair_ready,
    ${index('idx_session_run_athletes_athlete', MARKS, ['organization_id', 'athlete_id', 'marked_at'], '')} as athlete_index_ready,
    exists (
      select 1 from pg_attribute a
       where a.attrelid = ${NOTES} and a.attname = 'run_id' and not a.attisdropped
         and format_type(a.atttypid, a.atttypmod) = 'text' and not a.attnotnull
    ) as notes_run_id_ready,
    exists (
      select 1 from pg_attribute a
       where a.attrelid = ${NOTES} and a.attname = 'session_id' and not a.attisdropped and not a.attnotnull
    ) as notes_session_id_nullable,
    ${check(NOTES, 'pilot_session_staff_notes_one_subject', 'CHECK ((num_nonnulls(session_id, run_id) = 1))')} as notes_one_subject_ready,
    ${foreignKey(NOTES, ['organization_id', 'run_id', 'athlete_id'], 'pilot.session_run_athletes',
      ['organization_id', 'run_id', 'athlete_id'], 'c')} as notes_run_athlete_fk_ready,
    ${index('idx_session_staff_notes_run', NOTES, ['organization_id', 'run_id', 'athlete_id', 'created_at'], '(run_id IS NOT NULL)')} as notes_run_index_ready
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    // The migration takes brief locks on the notes table and on the tables its foreign keys
    // point at (accounts, athletes, organizations, runs). Rather than queue sign-in and every
    // other write to those behind a long transaction already holding one of them, give up and
    // let the operator re-run in a quieter moment. Nothing is half-applied: it is one transaction.
    await client.query("set local lock_timeout = '10s'");
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`SESSION_RUN_ATHLETES_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_session_run_athletes_migration.sql',
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
  console.log(`Applied session run athletes migration: ${migrationPath}`);
  console.log('PILOT SESSION RUN ATHLETES MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SESSION RUN ATHLETES MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
