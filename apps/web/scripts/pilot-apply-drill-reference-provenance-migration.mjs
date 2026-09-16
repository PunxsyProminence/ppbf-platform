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

// Asserts what the migration PROMISED, not that a statement ran.
//
// to_regclass() rather than the ::regclass cast, as in the sibling runners: the
// cast raises before any column is evaluated when a table is absent, which would
// report an unmigrated database as a SQL error instead of as unreadiness.
//
// Every clause below corresponds to one sentence of OD-2026-09-16-001, and each
// is asserted by SHAPE rather than by name alone, because a constraint carrying
// the right name and the wrong definition is exactly the failure a name-only
// lookup cannot see:
//   * both tables exist -- a database without pilot.drill_library cannot have
//     produced this key, and saying so is more useful than a false constraint miss
//   * the column exists AND IS NULLABLE -- a NOT NULL column here would break
//     every hand-authored drill, which the ruling explicitly protects
//   * the foreign key is composite, targets pilot.drill_library, and does NOT
//     cascade -- a cascading key would delete assignable drills when reference
//     content is removed
//   * the duplicate-protection index exists, is UNIQUE, and is PARTIAL on
//     "reference_drill_id is not null" -- a total unique index would refuse a
//     second hand-authored drill, and a non-unique one would protect nothing
const READINESS_QUERY = `
  select
    to_regclass('pilot.drills') is not null as drills_table_ready,
    to_regclass('pilot.drill_library') is not null as drill_library_table_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'drills'
        and column_name = 'reference_drill_id'
        and is_nullable = 'YES'
    ) as reference_drill_id_column_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drills_reference_drill_fk'
        and conrelid = to_regclass('pilot.drills')
        and contype = 'f'
        and confrelid = to_regclass('pilot.drill_library')
        and pg_get_constraintdef(oid) like '%(organization_id, reference_drill_id)%'
        and pg_get_constraintdef(oid) not like '%ON DELETE CASCADE%'
        and pg_get_constraintdef(oid) not like '%ON DELETE SET NULL%'
    ) as reference_drill_fk_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.drills')
        and c.relname = 'pilot_drills_one_reference_per_org'
        and i.indisunique
        and pg_get_expr(i.indpred, i.indrelid) is not null
    ) as one_reference_per_org_index_ready,
    -- The migration promises it does not touch the reference table. A dispatch
    -- that found pilot.drill_library.drill_id gone has applied something other
    -- than what this file says it applies.
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'drill_library'
        and column_name = 'drill_id'
    ) as drill_library_identity_intact
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('DRILL_REFERENCE_PROVENANCE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_drill_reference_provenance_migration.sql',
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
  console.log(`Applied drill reference provenance migration: ${migrationPath}`);
  console.log('PILOT DRILL REFERENCE PROVENANCE MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT DRILL REFERENCE PROVENANCE MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
