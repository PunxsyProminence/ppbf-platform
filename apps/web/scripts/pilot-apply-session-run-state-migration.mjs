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

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

// Checks the columns, every constraint, and the partial unique index by name. Asserting only that
// the columns exist would pass against a table whose guards silently failed to attach, which is
// the half-applied state this readiness gate exists to catch.
const READINESS_QUERY = `
  select
    to_regclass('pilot.session_script_runs') is not null as runs_table_ready,
    (
      select count(*) = 6 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'session_script_runs'
        and column_name in (
          'run_state', 'started_at', 'ended_at',
          'current_block_id', 'paused_at', 'paused_seconds'
        )
    ) as columns_ready,
    (
      select count(*) = 6 from pg_constraint
      where conrelid = to_regclass('pilot.session_script_runs')
        and conname in (
          'pilot_ssrun_state_vocab',
          'pilot_ssrun_state_times',
          'pilot_ssrun_end_after_start',
          'pilot_ssrun_pause_only_live',
          'pilot_ssrun_paused_seconds_sane',
          'pilot_ssrun_current_block_fk'
        )
    ) as constraints_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'pilot_ssrun_one_live_per_coach'
    ) as one_live_per_coach_ready,
    -- run_state must stay nullable. A future default or NOT NULL would silently relabel the
    -- pre-tracking rows this migration deliberately leaves as NULL.
    (
      select is_nullable = 'YES' from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'session_script_runs'
        and column_name = 'run_state'
    ) as run_state_still_nullable
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('SESSION_RUN_STATE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_session_run_state_migration.sql',
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
  console.log(`Applied session run state migration: ${migrationPath}`);
  console.log('PILOT SESSION RUN STATE MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SESSION RUN STATE MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
