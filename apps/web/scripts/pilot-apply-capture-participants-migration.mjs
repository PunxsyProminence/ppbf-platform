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
// `teaching_media_anonymous` is the load-bearing one, and it is the whole
// point of the slice: after this migration no take-backed video may still
// carry athlete_id. A database that got the tables but kept the column
// populated would report as migrated while teaching media still names
// children -- the exact state this exists to end. The migration itself raises
// on that condition too; this is the check that refuses a database where
// somebody applied the DDL by hand and skipped the data half.
//
// `identity_recoverable` is its necessary twin. Anonymising without a
// surviving restricted link would not be privacy, it would be losing the only
// record of whose footage this is -- so the consent check and any safeguarding
// escalation would silently have nobody to resolve. Asserting that at least as
// many participant links exist as there are take-backed videos is what
// distinguishes "identity moved" from "identity destroyed". It is written as a
// comparison rather than an equality because a video may legitimately predate
// any participant only if it also has no athlete to derive one from, and that
// case is already refused by teaching_media_anonymous.
//
// EVERY FOREIGN-KEY CHECK ALSO PINS ITS ARITY, for the same tenant reason the
// capture-sessions runner gives: a single-column reference would let a
// participant in one organization name a video in another. `array_length(
// conkey, 1) = 2` is what refuses a database where somebody replaced the
// composite key with the simpler-looking one.
//
// `participant_unique_ready` pins the one-row-per-athlete index. Without it a
// second participant row for the same person could exist, and a guardian
// withdrawing consent would reach one of them while footage hung off the
// other -- a withdrawal that silently does not withdraw.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// column is evaluated when a table is absent, which would report an
// unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.capture_participants') is not null as capture_participants_ready,
    to_regclass('pilot.recording_session_participants') is not null as session_participants_ready,
    to_regclass('pilot.video_capture_participants') is not null as video_participants_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_capture_participants_org_athlete'
        and indexdef like '%UNIQUE%'
    ) as participant_unique_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'capture_participants_athlete_fk'
        and conrelid = to_regclass('pilot.capture_participants')
        and contype = 'f'
        and array_length(conkey, 1) = 2
    ) as participant_athlete_fk_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'video_capture_participants_video_fk'
        and conrelid = to_regclass('pilot.video_capture_participants')
        and contype = 'f'
        and array_length(conkey, 1) = 2
    ) as video_participant_fk_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'video_capture_participants_participant_fk'
        and conrelid = to_regclass('pilot.video_capture_participants')
        and contype = 'f'
        and array_length(conkey, 1) = 2
    ) as video_participant_identity_fk_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'recording_session_participants_session_fk'
        and conrelid = to_regclass('pilot.recording_session_participants')
        and contype = 'f'
        and array_length(conkey, 1) = 2
    ) as session_participant_fk_ready,
    (
      select count(*) = 0
      from pilot.video_sessions
      where capture_take_id is not null
        and athlete_id is not null
    ) as teaching_media_anonymous,
    (
      select
        (select count(*) from pilot.video_sessions where capture_take_id is not null)
        <= (select count(*) from pilot.video_capture_participants)
        or (select count(*) from pilot.video_sessions where capture_take_id is not null) = 0
    ) as identity_recoverable,
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
    throw new Error('CAPTURE_PARTICIPANTS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_capture_participants_migration.sql',
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
  console.log(`Applied capture participants migration: ${migrationPath}`);
  console.log('PILOT CAPTURE PARTICIPANTS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT CAPTURE PARTICIPANTS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
