import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the athlete-pathway migration (map item 17) inside one transaction,
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

// Asserts all three tables, each one's cascade to the athlete (which is what
// puts these rows in the retention purge), each partial unique index that holds
// "one live row", and the reason and goal-pair checks, each looked up ON ITS
// OWN TABLE, so an environment missing any piece cannot pass readiness.
const READINESS_QUERY = `
  with c as (
    select conname, confdeltype, conrelid from pg_constraint
    where conrelid in (
      to_regclass('pilot.athlete_pathway_stages'),
      to_regclass('pilot.athlete_pathway_checkpoints'),
      to_regclass('pilot.athlete_pathway_minor_allowances')
    )
  ),
  -- Each "one live row" index, looked up on ITS table, must be unique and
  -- partial; a same-named plain index somewhere else does not count.
  i as (
    select ic.relname as indexname, x.indrelid
    from pg_index x
    join pg_class ic on ic.oid = x.indexrelid
    where x.indisunique and x.indpred is not null
  )
  select
    to_regclass('pilot.athlete_pathway_stages') is not null as stages_ready,
    to_regclass('pilot.athlete_pathway_checkpoints') is not null as checkpoints_ready,
    to_regclass('pilot.athlete_pathway_minor_allowances') is not null as allowances_ready,
    exists (
      select 1 from c where conname = 'pilot_athlete_pathway_stages_athlete_fk' and confdeltype = 'c'
        and conrelid = to_regclass('pilot.athlete_pathway_stages')
    ) as stages_cascade_ready,
    exists (
      select 1 from c where conname = 'pilot_athlete_pathway_checkpoints_athlete_fk' and confdeltype = 'c'
        and conrelid = to_regclass('pilot.athlete_pathway_checkpoints')
    ) as checkpoints_cascade_ready,
    exists (
      select 1 from c where conname = 'pilot_athlete_pathway_minor_allowances_athlete_fk' and confdeltype = 'c'
        and conrelid = to_regclass('pilot.athlete_pathway_minor_allowances')
    ) as allowances_cascade_ready,
    exists (
      select 1 from c where conname = 'pilot_athlete_pathway_checkpoints_goal_check'
        and conrelid = to_regclass('pilot.athlete_pathway_checkpoints')
    ) as goal_pair_check_ready,
    exists (
      select 1 from c where conname = 'pilot_athlete_pathway_minor_allowances_reason_check'
        and conrelid = to_regclass('pilot.athlete_pathway_minor_allowances')
    ) as reason_check_ready,
    exists (
      select 1 from i where indexname = 'idx_athlete_pathway_stages_current'
        and indrelid = to_regclass('pilot.athlete_pathway_stages')
    ) as one_current_stage_ready,
    exists (
      select 1 from i where indexname = 'idx_athlete_pathway_checkpoints_live'
        and indrelid = to_regclass('pilot.athlete_pathway_checkpoints')
    ) as one_live_checkpoint_ready,
    exists (
      select 1 from i where indexname = 'idx_athlete_pathway_minor_allowances_live'
        and indrelid = to_regclass('pilot.athlete_pathway_minor_allowances')
    ) as one_live_allowance_ready,
    exists (
      select 1 from c where conname = 'pilot_athlete_pathway_stages_superseded_by_fk'
        and conrelid = to_regclass('pilot.athlete_pathway_stages')
    ) as superseded_chain_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('ATHLETE_PATHWAY_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_athlete_pathway_migration.sql',
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
  console.log(`Applied athlete pathway migration: ${migrationPath}`);
  console.log('PILOT ATHLETE PATHWAY MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ATHLETE PATHWAY MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
