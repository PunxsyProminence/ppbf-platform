import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the session-objective-link migration (which Full Spectrum
// objectives a delivered session addressed) inside one transaction, with the same
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
// here is satisfied by session-block-link or by
// athlete-development-block-objectives on their own.
//
// BOTH FOREIGN KEYS ARE CHECKED BY PARENT AND BY DELETE ACTION, not by name.
// A constraint carrying the right name against the wrong parent is the
// copy-paste failure this gate exists for, and confdeltype = 'c' (ON DELETE
// CASCADE) is not decoration: a NO ACTION key here would silently block
// dataDeletion.ts's retention purge, which relies entirely on cascades, and
// the failure would surface years later as a minor's record that outlived its
// retention period.
//
// The unique index this migration adds to the objectives table is checked
// too. Without it the objective foreign key cannot exist at all, so a
// database missing it is one where the invariant is unenforced.
const READINESS_QUERY = `
  select
    to_regclass('pilot.session_run_block_objective_links') is not null as table_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.session_run_block_objective_links')
        and contype = 'p'
        and array_length(conkey, 1) = 3
    ) as pair_identity_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'uq_adb_objectives_org_objective_block'
    ) as objective_key_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.session_run_block_objective_links')
        and contype = 'f'
        and conname = 'pilot_session_run_objective_links_objective_fk'
        and confrelid = to_regclass('pilot.athlete_development_block_objectives')
        and confdeltype = 'c'
    ) as objective_tenancy_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.session_run_block_objective_links')
        and contype = 'f'
        and conname = 'pilot_session_run_objective_links_block_link_fk'
        and confrelid = to_regclass('pilot.session_run_development_block_links')
        and confdeltype = 'c'
    ) as block_link_implied_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_session_run_objective_links_by_objective'
    ) as objective_index_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_session_run_objective_links_by_block'
    ) as block_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('SESSION_OBJECTIVE_LINK_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_session_objective_link_migration.sql',
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
  console.log(`Applied session objective link migration: ${migrationPath}`);
  console.log('PILOT SESSION OBJECTIVE LINK MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SESSION OBJECTIVE LINK MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
