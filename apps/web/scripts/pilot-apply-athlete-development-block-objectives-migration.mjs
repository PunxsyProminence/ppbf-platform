import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the athlete-development-block-objectives foundation migration (module 036)
// inside one transaction, with the same target-verification discipline as
// every other pilot:apply-* script: the operator must state which host and
// database they believe they are pointing at, and a mismatch refuses before
// any DDL runs.

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

// Every clause here is something the base schema does NOT already provide,
// so this assertion can genuinely refuse a database the migration never
// reached -- the property migrationReadinessGates.pg.test.ts exists to hold
// runners to, after #488 shipped one that could never pass and seven that
// could never fail.
//
// The vocabulary clauses match deparsed literals rather than source text:
// Postgres re-renders `x in (...)` from the parsed tree as
// `x = ANY (ARRAY['technical'::text, ...])`, so the stable substrings are the
// quoted literals themselves.
//
// WHAT THIS DELIBERATELY DOES NOT ASSERT: that
// 'nutrition_body_composition' is ABSENT from the domain vocabulary. The
// withheld tenth domain is a policy awaiting one owner decision, and a
// deploy gate that encoded it would refuse every dispatch the day the owner
// reverses it -- turning a one-line vocabulary change into a blocked
// release. That the vocabulary is exactly nine belongs in the migration
// test, which is edited in the same commit as the vocabulary; this gate
// asserts only that the constraint exists and holds real values.
const READINESS_QUERY = `
  select
    to_regclass('pilot.athlete_development_block_objectives') is not null as table_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.athlete_development_block_objectives')
        and contype = 'c'
        and conname = 'pilot_athlete_development_block_objectives_status_check'
        and pg_get_constraintdef(oid) like '%''draft''%'
        and pg_get_constraintdef(oid) like '%''cancelled''%'
    ) as status_vocabulary_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.athlete_development_block_objectives')
        and contype = 'c'
        and conname = 'pilot_athlete_development_block_objectives_domain_check'
        and pg_get_constraintdef(oid) like '%''technical''%'
        and pg_get_constraintdef(oid) like '%''sparring_live_progression''%'
    ) as domain_vocabulary_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.athlete_development_block_objectives')
        and contype = 'f'
        and conname = 'pilot_athlete_development_block_objectives_block_fk'
        and confrelid = to_regclass('pilot.athlete_development_blocks')
    ) as block_tenancy_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_athlete_development_block_objectives_by_block'
    ) as block_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('ATHLETE_DEVELOPMENT_BLOCK_OBJECTIVES_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_athlete_development_block_objectives_migration.sql',
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
  console.log(`Applied athlete development block objectives migration: ${migrationPath}`);
  console.log('PILOT ATHLETE DEVELOPMENT BLOCK OBJECTIVES MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ATHLETE DEVELOPMENT BLOCK OBJECTIVES MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
