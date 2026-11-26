import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the second email alert sweep indexes migration (lane W4-1,
// EM-IX-2: created_at on pilot.family_thread_posts and
// pilot.coach_observations) inside one transaction, with the same
// target-verification discipline as every other pilot:apply-* script: the
// operator must state which host and database they believe they are pointing
// at, and a mismatch refuses before any DDL runs. Adapted from EM-IX's runner
// (pilot-apply-email-alert-sweep-indexes-migration.mjs); only the index list,
// the file, the error code and the log lines differ.

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

/** The indexes this migration promises, each on its own table. */
export const SWEEP_INDEXES = [
  { name: 'idx_pilot_family_thread_posts_created_at', table: 'pilot.family_thread_posts' },
  { name: 'idx_pilot_coach_observations_created_at', table: 'pilot.coach_observations' },
];

// Asserts each index by what it IS, not only by name: on its own table,
// valid (a CONCURRENTLY build that failed would leave an invalid index of
// this name; this file never builds that way, but the check should not trust
// the name), a plain b-tree (not partial, not unique, not an exclusion
// constraint's index, which would refuse two rows with the same time), and
// keyed on exactly
// (created_at): one column in all (indnatts, so no INCLUDE column and no
// second key), and that column is created_at. An expression key has attnum 0,
// so it drops out of the column join below and the names do not match. The key columns are read back by name, in index order,
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
        -- A same-named partial, unique or non-btree index would also satisfy
        -- "if not exists"; it is not the index this migration promises.
        and i.indpred is null
        and not i.indisunique
        and not i.indisexclusion
        and i.indnatts = 1
        and c.relam = (select oid from pg_am where amname = 'btree')
        and (
          select array_agg(a.attname::text order by k.ord)
            from unnest(i.indkey) with ordinality as k(attnum, ord)
            join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
        ) = array['created_at']::text[]
    ) as present
    from (values ${SWEEP_INDEXES.map((index) => `('${index.name}', '${index.table}')`).join(', ')})
      as want(index_name, table_name)
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
    // wait), held until COMMIT, and a re-run takes it too. Rather than queue
    // behind a long transaction already holding a write lock, and hold every
    // new family thread post or coach note up behind it, give up after 10
    // seconds and let the operator re-run in a quieter moment, as EM-IX's
    // runner and the other pilot:apply-* runners that lock busy tables do.
    // Nothing is half-applied: it is one transaction.
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
