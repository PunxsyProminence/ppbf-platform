import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the training-tracks migration (backbone crossover lane FT1a) inside one transaction,
// with the same target-verification discipline as every other pilot:apply-*
// script: the operator must state which host and database they believe they
// are pointing at, and a mismatch refuses before any DDL runs.

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

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

// Asserts the three tables and their primary keys, each one's own cascade from
// its organization, a block's cascade from its track version and a block
// session's from its block, the one-current-version-per-lineage index, the
// order and lineage uniques, every named check, and the jsonb and text[] types
// of the columns the content-import engine reads and writes by type
// (templateScriptVersions.ts), so an environment missing any piece cannot
// pass. Constraints are found by name AND by table, so a same-named constraint
// elsewhere cannot stand in.
const READINESS_QUERY = `
  with c as (
    select conname, contype, confdeltype, conrelid, confrelid from pg_constraint
    where conrelid in (
      to_regclass('pilot.training_tracks'),
      to_regclass('pilot.track_blocks'),
      to_regclass('pilot.track_block_sessions')
    )
  )
  select
    to_regclass('pilot.training_tracks') is not null as tracks_ready,
    to_regclass('pilot.track_blocks') is not null as blocks_ready,
    to_regclass('pilot.track_block_sessions') is not null as sessions_ready,
    (select count(distinct conrelid) from c where contype = 'f' and confdeltype = 'c'
       and confrelid = to_regclass('pilot.organizations')
    ) = 3 as organization_cascade_ready,
    (select count(*) from c where contype = 'p' and conname in (
       'pilot_training_tracks_pkey', 'pilot_track_blocks_pkey', 'pilot_track_block_sessions_pkey')
    ) = 3 as primary_keys_ready,
    exists (
      select 1 from c where contype = 'f' and confdeltype = 'c' and conname = 'pilot_track_blocks_track_fkey'
        and conrelid = to_regclass('pilot.track_blocks') and confrelid = to_regclass('pilot.training_tracks')
    ) as block_track_cascade_ready,
    exists (
      select 1 from c where contype = 'f' and confdeltype = 'c' and conname = 'pilot_track_block_sessions_block_fkey'
        and conrelid = to_regclass('pilot.track_block_sessions') and confrelid = to_regclass('pilot.track_blocks')
    ) as session_block_cascade_ready,
    (select count(*) from c where contype = 'u' and conname in (
       'pilot_training_tracks_lineage_version_uq', 'pilot_track_blocks_order_uq',
       'pilot_track_blocks_lineage_uq', 'pilot_track_block_sessions_ordinal_uq')
    ) = 4 as uniques_ready,
    (select count(*) from c where contype = 'c' and conname in (
       'pilot_training_tracks_id_check', 'pilot_training_tracks_lineage_check', 'pilot_training_tracks_version_check',
       'pilot_training_tracks_name_check', 'pilot_training_tracks_lane_check', 'pilot_training_tracks_track_check',
       'pilot_training_tracks_duration_check', 'pilot_training_tracks_status_check', 'pilot_training_tracks_details_check',
       'pilot_track_blocks_id_check', 'pilot_track_blocks_lineage_check', 'pilot_track_blocks_order_check',
       'pilot_track_blocks_weeks_check', 'pilot_track_blocks_status_check', 'pilot_track_blocks_field_labels_check',
       'pilot_track_blocks_evidence_check', 'pilot_track_blocks_details_check',
       'pilot_track_block_sessions_id_check', 'pilot_track_block_sessions_ordinal_check', 'pilot_track_block_sessions_week_check',
       'pilot_track_block_sessions_day_check', 'pilot_track_block_sessions_template_check')
    ) = 22 as checks_ready,
    (select count(*) from information_schema.columns
      where table_schema = 'pilot'
        and ((table_name in ('training_tracks', 'track_blocks') and column_name = 'details' and data_type = 'jsonb')
          or (table_name in ('training_tracks', 'track_blocks') and column_name = 'sources' and data_type = 'ARRAY')
          or (table_name = 'track_blocks' and column_name in ('field_labels', 'evidence') and data_type = 'jsonb')
          or (table_name = 'track_blocks' and column_name = 'stage_keys' and data_type = 'ARRAY'))
    ) = 7 as typed_columns_ready,
    exists (
      select 1 from pg_index i
       where i.indexrelid = to_regclass('pilot.pilot_training_tracks_one_head_per_lineage')
         and i.indrelid = to_regclass('pilot.training_tracks')
         and i.indisunique and i.indpred is not null
    ) as one_head_per_lineage_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('TRAINING_TRACKS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_training_tracks_migration.sql',
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
  console.log(`Applied training tracks migration: ${migrationPath}`);
  console.log('PILOT TRAINING TRACKS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT TRAINING TRACKS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
