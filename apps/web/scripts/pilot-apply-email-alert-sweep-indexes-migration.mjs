import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the email alert sweep indexes migration (lane W4-1, EM-IX) inside
// one transaction, with the same target-verification discipline as every
// other pilot:apply-* script: the operator must state which host and database
// they believe they are pointing at, and a mismatch refuses before any DDL
// runs.

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
  { name: 'idx_pilot_safety_escalations_created_at', table: 'pilot.safety_escalations' },
  { name: 'idx_pilot_family_message_replies_created_at', table: 'pilot.family_message_replies' },
];

// Asserts each index by what it IS, not only by name: on its own table,
// valid (a CONCURRENTLY build that failed would leave an invalid index of
// this name; this file never builds that way, but the check should not trust
// the name), a plain b-tree (not partial, not unique), and keyed on exactly
// (created_at). The key columns are read back by name, in index order,
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
    throw new Error('EMAIL_ALERT_SWEEP_INDEXES_NOT_READY');
  }
}

export async function applyMigrationTransaction(client, sql) {
  await client.query('BEGIN');
  try {
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
    '../../../infra/azure/pilot_slice_postgres_email_alert_sweep_indexes_migration.sql',
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
  console.log(`Applied email alert sweep indexes migration: ${migrationPath}`);
  console.log('PILOT EMAIL ALERT SWEEP INDEXES MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT EMAIL ALERT SWEEP INDEXES MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
