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

// Asserts the PROPERTIES this migration exists for, not merely that objects
// with these names turned up.
//
// `one_open_take_ready` is the load-bearing one. The whole point of the take
// table is that exactly one attempt is current at a time: two open takes would
// let two phones each record what they believe is "the current attempt" and
// attach their files to different takes, producing footage that looks grouped
// and is not. That rule lives in a PARTIAL UNIQUE INDEX, so a database that
// got the table without the index would accept the bad state while reporting
// as migrated. This is the assertion that refuses such a database.
//
// `open_code_unique_ready` is the same shape of check for join codes: without
// the partial index two open sessions in one organization could share a code
// and a joining device would silently land in whichever the query returned.
//
// The video_sessions columns are asserted NULLABLE on purpose, the opposite of
// most runners here. Every video uploaded before this migration has no session,
// take or viewpoint, and there is no honest value to backfill -- so a later
// edit tightening these to NOT NULL could only be satisfied by inventing
// provenance. The runner refuses that edit rather than trusting nobody makes it.
//
// `capture_source_check_ready` pins the constraint that keeps capture_source a
// closed vocabulary; without it the column accepts any string and the
// distinction between recorded and uploaded footage stops being reliable.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// column is evaluated when a table is absent, which would report an unmigrated
// database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.recording_sessions') is not null as recording_sessions_ready,
    to_regclass('pilot.capture_takes') is not null as capture_takes_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_capture_takes_one_open'
        and indexdef like '%UNIQUE%'
        and indexdef like '%state%'
    ) as one_open_take_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_recording_sessions_open_code'
        and indexdef like '%UNIQUE%'
    ) as open_code_unique_ready,
    (
      select count(*) = 6
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'video_sessions'
        and column_name in (
          'recording_session_id',
          'capture_take_id',
          'camera_view_id',
          'camera_view',
          'recorded_at',
          'capture_source'
        )
        and is_nullable = 'YES'
    ) as video_columns_nullable_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'video_sessions_capture_source_check'
        and conrelid = to_regclass('pilot.video_sessions')
        and contype = 'c'
    ) as capture_source_check_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'video_sessions_recording_session_fk'
        and conrelid = to_regclass('pilot.video_sessions')
        and contype = 'f'
        and confdeltype = 'n'
    ) as recording_session_fk_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'video_sessions_capture_take_fk'
        and conrelid = to_regclass('pilot.video_sessions')
        and contype = 'f'
        and confdeltype = 'n'
    ) as capture_take_fk_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'video_sessions'
        and column_name = 'blob_path'
    ) as source_media_intact
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('CAPTURE_SESSIONS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_capture_sessions_migration.sql',
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
  console.log(`Applied capture sessions migration: ${migrationPath}`);
  console.log('PILOT CAPTURE SESSIONS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT CAPTURE SESSIONS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
