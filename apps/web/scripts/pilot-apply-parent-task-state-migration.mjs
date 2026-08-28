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

const READINESS_QUERY = `
  select
    to_regclass('pilot.parent_task_state') is not null as table_ready,
    (
      select count(*) = 8
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'parent_task_state'
    ) as column_count_ready,
    -- The design property, asserted by the runner rather than trusted: this
    -- table must carry NO verification column. pilot.assignment_completions
    -- has verification_status and verified_by_account_id because a coach
    -- verifies an athlete's technical work; a guardian bringing gloves is not
    -- that, and a column to countersign it would be the masquerade this table
    -- exists to avoid. If a later migration adds one, the deploy stops here.
    (
      select count(*) = 0
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'parent_task_state'
        and (column_name like '%verif%' or column_name like '%approv%')
    ) as no_verification_column_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_parent_task_state_note_fk'
        and conrelid = to_regclass('pilot.parent_task_state')
        and contype = 'f'
    ) as note_fk_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_parent_task_state_completion_paired'
        and conrelid = to_regclass('pilot.parent_task_state')
        and contype = 'c'
    ) as completion_check_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_parent_task_state_open'
    ) as index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('PARENT_TASK_STATE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_parent_task_state_migration.sql',
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
  console.log(`Applied parent task state migration: ${migrationPath}`);
  console.log('PILOT PARENT TASK STATE MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT PARENT TASK STATE MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
