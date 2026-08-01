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

// Asserts the five columns, both check constraints and the read-path index.
//
// placement_defaults_ready is the one that protects the rows already in the
// table: placement, kind and active must be NOT NULL with a default, because
// that is what backfills every pre-existing announcement into a visible gym
// notice. Columns added nullable would leave those rows outside a
// placement-filtered read while every catalog-existence check still passed.
const READINESS_QUERY = `
  select
    to_regclass('pilot.announcements') is not null as announcements_ready,
    (
      select count(*) = 5
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'announcements'
        and column_name in ('placement', 'kind', 'active', 'starts_at', 'ends_at')
    ) as placement_columns_ready,
    (
      select count(*) = 3
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'announcements'
        and is_nullable = 'NO'
        and column_default is not null
        and column_name in ('placement', 'kind', 'active')
    ) as placement_defaults_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_announcements_placement_check'
        and conrelid = 'pilot.announcements'::regclass
    ) as placement_check_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_announcements_kind_check'
        and conrelid = 'pilot.announcements'::regclass
    ) as kind_check_ready,
    exists (
      select 1
      from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_pilot_announcements_org_placement_kind_active_created'
    ) as placement_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('ANNOUNCEMENT_PLACEMENT_COLUMNS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_announcement_placements_migration.sql',
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
  console.log(`Applied announcement placements migration: ${migrationPath}`);
  console.log('PILOT ANNOUNCEMENT PLACEMENTS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ANNOUNCEMENT PLACEMENTS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
