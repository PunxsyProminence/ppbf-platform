import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the second email alert sweep indexes migration (lane W4-1,
// EM-IX-2: the gym_notice expression on pilot.announcements, and created_at
// on pilot.family_thread_posts and pilot.coach_observations) inside one
// transaction, with the same target-verification discipline as EM-IX's
// runner: the operator must state which host and database they believe they
// are pointing at, and a mismatch refuses before any DDL runs. Adapted from
// EM-IX's runner (pilot-apply-email-alert-sweep-indexes-migration.mjs); the
// index list, the file, the error code and the log lines differ, and the
// readiness check also requires each index to be ready and live and compares
// an expression key and a predicate.

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

export function parseConnectionTarget(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error('INVALID_POSTGRES_CONNECTION_STRING');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error('INVALID_POSTGRES_PROTOCOL');
  }

  const hostname = parsed.hostname.toLowerCase();
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!hostname || !database) {
    throw new Error('INCOMPLETE_POSTGRES_TARGET');
  }

  return { hostname, database };
}

function assertExpectedTarget(target, expectedHostname, expectedDatabase) {
  if (
    target.hostname !== expectedHostname.toLowerCase()
    || target.database !== expectedDatabase
  ) {
    throw new Error('POSTGRES_TARGET_MISMATCH');
  }
}

// Same reasoning as db.ts's resolveSslConfig and the other pilot-apply-*
// scripts: production/staging always require TLS.
function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

/**
 * The indexes this migration promises, each on its own table, with its one key
 * (a column, or an expression) and its predicate written as PostgreSQL prints
 * them back (pg_get_expr), null where there is none. The notice texts are the
 * migration's expression and predicate as PostgreSQL 18.4 normalised them.
 */
export const SWEEP_INDEXES = [
  {
    name: 'idx_pilot_announcements_notice_live_from',
    table: 'pilot.announcements',
    columns: null,
    expression: 'GREATEST(created_at, COALESCE(starts_at, created_at), updated_at)',
    predicate: "(kind = 'notice'::text)",
  },
  { name: 'idx_pilot_family_thread_posts_created_at', table: 'pilot.family_thread_posts', columns: ['created_at'], expression: null, predicate: null },
  { name: 'idx_pilot_coach_observations_created_at', table: 'pilot.coach_observations', columns: ['created_at'], expression: null, predicate: null },
];

// A SQL literal for one of the constants above (never input): quotes doubled.
const literal = (value) => (value === null ? 'null' : `'${value.replaceAll("'", "''")}'`);
const wantRow = (index) => `(${literal(index.name)}, ${literal(index.table)}, ${
  index.columns ? `array[${index.columns.map(literal).join(', ')}]` : 'null'}::text[], ${
  literal(index.expression)}::text, ${literal(index.predicate)}::text)`;

// Asserts each index by what it IS, not only by name: on its own table,
// valid (a CONCURRENTLY build that failed would leave an invalid index of
// this name; this file never builds that way, but the check should not trust
// the name), ready and live (pg_index's indisready and indislive: an index
// marked valid but not ready is not updated by new writes, so a read through
// it misses new rows), a plain b-tree (not unique, not an exclusion
// constraint's index, which would refuse two rows with the same time), one
// key in all (indnatts, so no INCLUDE column and no second key), and that key
// and the predicate exactly as promised: the column created_at with no
// expression and no predicate, or the notice expression (attnum 0, so no
// column) with kind = 'notice'. The texts are compared as pg_get_expr prints
// them, so a different expression or predicate does not match. The key columns are read back by name, in index order,
// through unnest(indkey) with ordinality, as the audit-events entity index
// runner does: `indkey::int2[] = array(...)` would compare a zero-based array
// and be false for every correct index.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// row is evaluated when a table is absent, which would report an unmigrated
// database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select coalesce(bool_and(present), false) as index_ready
  from (
    select exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'pilot'
        and c.relname = want.index_name
        and i.indrelid = to_regclass(want.table_name)
        and i.indisvalid
        and i.indisready
        and i.indislive
        -- A same-named index of another shape would also satisfy "if not
        -- exists"; it is not the index this migration promises.
        and not i.indisunique
        and not i.indisexclusion
        and i.indnatts = 1
        and c.relam = (select oid from pg_am where amname = 'btree')
        and pg_get_expr(i.indpred, i.indrelid) is not distinct from want.predicate
        and pg_get_expr(i.indexprs, i.indrelid) is not distinct from want.expression
        and (
          select array_agg(a.attname::text order by k.ord)
            from unnest(i.indkey) with ordinality as k(attnum, ord)
            join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
        ) is not distinct from want.columns
    ) as present
    from (values ${SWEEP_INDEXES.map(wantRow).join(', ')})
      as want(index_name, table_name, columns, expression, predicate)
  ) each_index
`;

function assertReadiness(row) {
  if (!row || row.index_ready !== true) {
    throw new Error('EMAIL_ALERT_SWEEP_INDEXES_2_NOT_READY');
  }
}

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
    // Each index build takes a SHARE lock on its table (reads go on, writes
    // wait), held until COMMIT, and a re-run takes it too. Behind a long
    // transaction already writing to a table, the runner waits for that lock,
    // and new writes to the table queue behind the runner while it waits. The
    // timeout caps each such wait at 10 seconds: then the runner fails with
    // 55P03 and rolls back, and the operator re-runs in a quieter moment.
    // EM-IX's runner does the same. Each table's writes are held from the
    // moment the runner waits for it until COMMIT, so the SQL builds the
    // announcements index first (see its FORM note). Nothing is half-applied:
    // it is one transaction.
    await client.query("set local lock_timeout = '10s'");
    await client.query(sql);
    const readiness = await client.query(READINESS_QUERY);
    assertReadiness(readiness.rows[0]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

export async function run() {
  const connectionString = required('AZURE_POSTGRES_CONNECTION_STRING');
  const expectedHostname = required('PPBF_EXPECTED_POSTGRES_HOSTNAME');
  const expectedDatabase = required('PPBF_EXPECTED_POSTGRES_DATABASE');

  const target = parseConnectionTarget(connectionString);
  assertExpectedTarget(target, expectedHostname, expectedDatabase);

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const migrationPath = path.resolve(
    __dirname,
    '../../../infra/azure/pilot_slice_postgres_email_alert_sweep_indexes_2_migration.sql',
  );

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  try {
    await applyMigrationTransaction(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied email alert sweep indexes 2 migration: ${migrationPath}`);
  console.log('PILOT EMAIL ALERT SWEEP INDEXES 2 MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT EMAIL ALERT SWEEP INDEXES 2 MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
