import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the session-block-link migration (which delivered session supported
// which athlete development block) inside one transaction, with the same
// target-verification discipline as every other pilot:apply-* script: the
// operator must state which host and database they believe they are pointing
// at, and a mismatch refuses before any DDL runs.

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

// Every clause names something ONLY this migration creates, so this assertion
// can genuinely refuse a database the migration never reached -- the property
// migrationReadinessGates.pg.test.ts exists to hold runners to, after #488
// shipped one that could never pass and seven that could never fail. Nothing
// here is satisfied by the base schema, by session-scripts, or by
// athlete-development-blocks.
//
// Both foreign keys are checked by confrelid rather than by name alone,
// because a constraint carrying the right name against the wrong parent is
// exactly the copy-paste failure this gate is for.
//
// THE DELETE ACTIONS ARE PART OF READINESS, and that is not decoration. If
// either key shipped as NO ACTION, this table would silently block
// dataDeletion.ts's retention purge -- a bare `delete from pilot.athletes`
// that relies on cascades to carry every child. confdeltype = 'c' is
// Postgres's code for ON DELETE CASCADE, so a migration applied without it is
// refused here rather than discovered by a failed purge two years from now.
const READINESS_QUERY = `
  select
    to_regclass('pilot.session_run_development_block_links') is not null as table_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.session_run_development_block_links')
        and contype = 'p'
        and array_length(conkey, 1) = 3
    ) as pair_identity_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.session_run_development_block_links')
        and contype = 'f'
        and conname = 'pilot_session_run_block_links_run_fk'
        and confrelid = to_regclass('pilot.session_script_runs')
        and confdeltype = 'c'
    ) as run_tenancy_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.session_run_development_block_links')
        and contype = 'f'
        and conname = 'pilot_session_run_block_links_block_fk'
        and confrelid = to_regclass('pilot.athlete_development_blocks')
        and confdeltype = 'c'
    ) as block_tenancy_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_session_run_block_links_by_block'
    ) as block_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('SESSION_BLOCK_LINK_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_session_block_link_migration.sql',
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
  console.log(`Applied session block link migration: ${migrationPath}`);
  console.log('PILOT SESSION BLOCK LINK MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SESSION BLOCK LINK MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
