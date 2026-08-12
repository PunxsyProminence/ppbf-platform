import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

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

// Asserts what the migration is FOR, not merely that it ran.
//
// `feeder_tracks_not_null_ready` is the one worth having. The column is the
// capability half of the evidence axis, and a nullable version of it would
// import cleanly and then make every coverage query answer "unknown" for any
// capability whose feeders were absent -- indistinguishable, at the call site,
// from a capability that genuinely has no evidence. The default matters for the
// same reason: rows that predate this column must read as an empty track list,
// not as null.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// column is evaluated when a table is absent, which reports an unmigrated
// database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    exists (
      select 1
        from information_schema.columns
       where table_schema = 'pilot'
         and table_name = 'shadow_library_capability_map'
         and column_name = 'feeder_tracks'
    ) as feeder_tracks_column_ready,

    exists (
      select 1
        from information_schema.columns
       where table_schema = 'pilot'
         and table_name = 'shadow_library_capability_map'
         and column_name = 'feeder_tracks'
         and data_type = 'ARRAY'
         and udt_name = '_text'
    ) as feeder_tracks_text_array_ready,

    exists (
      select 1
        from information_schema.columns
       where table_schema = 'pilot'
         and table_name = 'shadow_library_capability_map'
         and column_name = 'feeder_tracks'
         and is_nullable = 'NO'
         and column_default is not null
    ) as feeder_tracks_not_null_ready,

    (to_regclass('pilot.idx_shadow_library_chunks_org_track') is not null)
      as chunk_track_index_ready
`;

function assertReadiness(row) {
  if (!row) {
    throw new Error('CAPABILITY_FEEDER_TRACKS_NOT_READY');
  }

  // Name the failing assertions. A bare code sends the next operator back into
  // the SQL to guess which of four outcomes did not land.
  const failed = Object.entries(row)
    .filter(([, value]) => value !== true)
    .map(([key]) => key);

  if (failed.length > 0) {
    throw new Error(`CAPABILITY_FEEDER_TRACKS_NOT_READY: ${failed.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_capability_feeder_tracks_migration.sql',
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
  console.log(`Applied capability feeder tracks migration: ${migrationPath}`);
  console.log('PILOT CAPABILITY FEEDER TRACKS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT CAPABILITY FEEDER TRACKS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
