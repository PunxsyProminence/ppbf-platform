import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the block-review migration (a coach's dated judgement about how a
// development block went) inside one transaction, with the same
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
// shipped one that could never pass and seven that could never fail.
//
// THE TWO CHECK CONSTRAINTS ARE PART OF READINESS, not decoration.
//
// The adherence vocabulary is verified by its deparsed literals rather than
// by the constraint's name: Postgres re-renders `x in (...)` from the parsed
// tree as `x = ANY (ARRAY['delivered_as_planned'::text, ...])`, so the stable
// substrings are the quoted values. Both ends are checked --
// 'delivered_as_planned' and 'unknown' -- because a constraint carrying both
// is this vocabulary and not a neighbour's four-value one.
//
// The deviations rule matters even more: without it a coach can record
// "delivered with deviations" and never say what they were, which is a
// judgement nobody can review. A database that has the table but not this
// constraint is one where that hole is open, so the gate refuses it.
const READINESS_QUERY = `
  select
    to_regclass('pilot.athlete_development_block_reviews') is not null as table_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.athlete_development_block_reviews')
        and contype = 'c'
        and conname = 'pilot_adb_reviews_adherence_check'
        and pg_get_constraintdef(oid) like '%''delivered_as_planned''%'
        and pg_get_constraintdef(oid) like '%''unknown''%'
    ) as adherence_vocabulary_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.athlete_development_block_reviews')
        and contype = 'c'
        and conname = 'pilot_adb_reviews_deviations_check'
    ) as deviations_rule_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.athlete_development_block_reviews')
        and contype = 'f'
        and conname = 'pilot_adb_reviews_block_fk'
        and confrelid = to_regclass('pilot.athlete_development_blocks')
        and confdeltype = 'c'
    ) as block_tenancy_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_adb_reviews_by_block'
    ) as block_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('BLOCK_REVIEW_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_block_review_migration.sql',
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
  console.log(`Applied block review migration: ${migrationPath}`);
  console.log('PILOT BLOCK REVIEW MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT BLOCK REVIEW MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
