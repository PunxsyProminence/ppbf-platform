import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the athlete development block -> competition/event target
// migration (module 036, Open Question 2 answered as (a)) inside one
// transaction, with the same target-verification discipline as every other
// pilot:apply-* script: the operator must state which host and database they
// believe they are pointing at, and a mismatch refuses before any DDL runs.
//
// The verification half below is the foundation runner's, unchanged. What
// differs is the readiness assertion, which must be able to fail on a
// database this migration never reached -- see the note above READINESS_QUERY.

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

// Every clause here is something the FOUNDATION migration does not already
// provide, so this assertion can genuinely refuse a database this widening
// never reached. That property is the one migrationReadinessGates.pg.test.ts
// exists to hold runners to, and it is easy to lose on a widening migration:
// asserting the table exists would pass on every database that has the
// foundation, which is all of them, and the gate would be decoration.
//
// So every clause names something added HERE: the two columns, the two
// composite foreign keys, the single-target check, and the two partial
// indexes.
//
// The foreign-key clauses check confrelid as well as the name, because a
// constraint carrying the right name against the wrong table is exactly the
// mistake a half-applied migration leaves behind.
const READINESS_QUERY = `
  select
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'athlete_development_blocks'
        and column_name = 'target_competition_id'
    ) as competition_column_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'athlete_development_blocks'
        and column_name = 'target_wrestling_event_id'
    ) as wrestling_event_column_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.athlete_development_blocks')
        and contype = 'f'
        and conname = 'pilot_athlete_development_blocks_target_competition_fk'
        and confrelid = to_regclass('pilot.external_competitions')
    ) as competition_tenancy_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.athlete_development_blocks')
        and contype = 'f'
        and conname = 'pilot_athlete_development_blocks_target_wrestling_event_fk'
        and confrelid = to_regclass('pilot.wrestling_league_events')
    ) as wrestling_event_tenancy_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.athlete_development_blocks')
        and contype = 'c'
        and conname = 'pilot_athlete_development_blocks_single_target_check'
    ) as single_target_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_athlete_development_blocks_by_target_competition'
    ) as competition_index_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_athlete_development_blocks_by_target_wrestling_event'
    ) as wrestling_event_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('ATHLETE_DEVELOPMENT_BLOCK_COMPETITION_TARGET_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_athlete_development_block_competition_target_migration.sql',
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
  console.log(`Applied athlete development block competition target migration: ${migrationPath}`);
  console.log('PILOT ATHLETE DEVELOPMENT BLOCK COMPETITION TARGET MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ATHLETE DEVELOPMENT BLOCK COMPETITION TARGET MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
