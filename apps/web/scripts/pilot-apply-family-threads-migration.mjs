import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

// Applies the family-threads migration (W4 item 4, PM-1a: a message a guardian starts to the
// coach, and the replies under it) inside one transaction. The operator names the host and
// database they believe they are pointing at (PPBF_EXPECTED_POSTGRES_HOSTNAME / _DATABASE); a
// mismatch refuses before connecting.

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

// The columns of a constraint's key, in key order.
const keyColumns = (relColumn, keyColumn) => `array(
  select a.attname::text from unnest(c.${keyColumn}) with ordinality as k(attnum, ord)
    join pg_attribute a on a.attrelid = c.${relColumn} and a.attnum = k.attnum
   order by k.ord)`;

const constraintOn = (table, where) => `exists (
  select 1 from pg_constraint c
   where c.conrelid = to_regclass('${table}') and ${where})`;

const keyReady = (table, name, type, columns) => constraintOn(
  table,
  `c.conname = '${name}' and c.contype = '${type}' and ${keyColumns('conrelid', 'conkey')} = array[${columns}]`,
);

// A foreign key with exactly these columns on each side and this delete action ('c' cascade,
// 'n' set null). By name when it has one; by its columns when the table declares it inline.
const foreignKeyReady = (table, name, refTable, from, to, onDelete) => constraintOn(
  table,
  `${name ? `c.conname = '${name}' and ` : ''}c.contype = 'f' and c.confrelid = to_regclass('${refTable}')
     and c.confdeltype = '${onDelete}'
     and ${keyColumns('conrelid', 'conkey')} = array[${from}]
     and ${keyColumns('confrelid', 'confkey')} = array[${to}]`,
);

// The check by name, validated, and its whole predicate exactly as PostgreSQL prints this
// migration's own (runs of whitespace collapsed): a same-named check that admits more fails.
const checkReady = (table, name, predicate) => constraintOn(
  table,
  `c.contype = 'c' and c.convalidated and c.conname = '${name}'
     and regexp_replace(pg_get_constraintdef(c.oid), '[[:space:]]+', ' ', 'g') = '${predicate.replaceAll("'", "''")}'`,
);

// BEFORE (bit 2), ROW (bit 1), on INSERT (4), DELETE (8) and UPDATE (16), firing in ordinary
// sessions (O or A; R fires only under replication, D never), calling this migration's function.
const guardReady = (table, trigger, fn) => `exists (
  select 1 from pg_trigger t
   where t.tgrelid = to_regclass('${table}') and t.tgname = '${trigger}' and not t.tgisinternal
     and t.tgenabled in ('O', 'A')
     and (t.tgtype & 2) = 2 and (t.tgtype & 1) = 1
     and (t.tgtype & 4) = 4 and (t.tgtype & 8) = 8 and (t.tgtype & 16) = 16
     and t.tgfoid = to_regprocedure('${fn}()'))`;

const POSTS = 'pilot.family_thread_posts';
const READS = 'pilot.family_thread_reads';
const ROLES = "CHECK ((%s = ANY (ARRAY['parent'::text, 'coach'::text, 'organization_admin'::text, 'admin'::text])))";

// Readiness asserts the result, not the attempt: each object looked up by name ON its own table,
// so a same-named object elsewhere does not pass, and the file's if-not-exists cannot hide a
// table built earlier with a different shape.
const READINESS_QUERY = `
  select
    to_regclass('${POSTS}') is not null as posts_table_ready,
    ${keyReady(POSTS, 'pilot_family_thread_posts_pkey', 'p', "'organization_id', 'post_id'")} as posts_primary_key_ready,
    ${keyReady(POSTS, 'pilot_family_thread_posts_post_athlete_key', 'u', "'organization_id', 'post_id', 'athlete_id'")} as posts_post_athlete_key_ready,
    ${foreignKeyReady(POSTS, 'pilot_family_thread_posts_athlete_fk', 'pilot.athletes', "'organization_id', 'athlete_id'", "'organization_id', 'athlete_id'", 'c')} as posts_athlete_fk_ready,
    ${foreignKeyReady(POSTS, 'pilot_family_thread_posts_thread_fk', POSTS, "'organization_id', 'thread_id', 'athlete_id'", "'organization_id', 'post_id', 'athlete_id'", 'c')} as posts_thread_fk_ready,
    ${foreignKeyReady(POSTS, null, 'pilot.accounts', "'author_account_id'", "'account_id'", 'n')} as posts_author_fk_set_null,
    ${checkReady(POSTS, 'pilot_family_thread_posts_role_check', ROLES.replace('%s', 'author_role'))} as posts_role_check_ready,
    ${checkReady(POSTS, 'pilot_family_thread_posts_opening_check', "CHECK (((post_id <> thread_id) OR (author_role = 'parent'::text)))")} as posts_opening_check_ready,
    ${checkReady(POSTS, 'pilot_family_thread_posts_text_check', 'CHECK (((length(btrim(post_text)) > 0) AND (length(post_text) <= 2000)))')} as posts_text_check_ready,
    ${guardReady(POSTS, 'trg_family_thread_posts_guard', 'pilot.family_thread_posts_guard')} as posts_guard_ready,
    to_regclass('${READS}') is not null as reads_table_ready,
    ${keyReady(READS, 'pilot_family_thread_reads_pkey', 'p', "'organization_id', 'post_id', 'reader_account_id'")} as reads_primary_key_ready,
    ${foreignKeyReady(READS, 'pilot_family_thread_reads_post_fk', POSTS, "'organization_id', 'post_id'", "'organization_id', 'post_id'", 'c')} as reads_post_fk_ready,
    ${foreignKeyReady(READS, null, 'pilot.accounts', "'reader_account_id'", "'account_id'", 'c')} as reads_reader_fk_cascade,
    ${checkReady(READS, 'pilot_family_thread_reads_role_check', ROLES.replace('%s', 'reader_role'))} as reads_role_check_ready,
    ${guardReady(READS, 'trg_family_thread_reads_guard', 'pilot.family_thread_reads_guard')} as reads_guard_ready
`;

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    const row = readiness.rows[0];
    const missing = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['readiness'];
    if (missing.length > 0) {
      throw new Error(`FAMILY_THREADS_NOT_READY: ${missing.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_family_threads_migration.sql',
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
  console.log(`Applied family threads migration: ${migrationPath}`);
  console.log('PILOT FAMILY THREADS MIGRATION PASS');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT FAMILY THREADS MIGRATION FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
