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

// Asserts what the migration actually produced, not merely that a table by that
// name is present. Three of these checks measure a property that a name-only
// check would pass while the migration's whole point was missing:
//
// `drill_name_unique_ready` asserts the index is UNIQUE and NOT PARTIAL
// (indpred is null). A plain non-unique index on (organization_id, name) would
// satisfy a name-only check and would still admit two drills of the same name
// in one gym -- the ambiguous anchor this table exists to prevent -- and a
// partial one would enforce the rule over only some rows.
//
// `assignment_drill_id_ready` asserts the column is NULLABLE. A NOT NULL
// drill_id would refuse every assignment that predates this migration, so an
// environment carrying one is worse off than an unmigrated one.
//
// `assignment_drill_fk_ready` asserts the foreign key is COMPOSITE over
// (organization_id, drill_id), points at pilot.drills, and deletes with
// RESTRICT (confdeltype = 'r'). A scalar key on drill_id alone would let one
// gym's assignment reference another gym's drill, and a cascading or
// null-setting rule would let a drill deletion reach assignment history.
//
// The difficulty vocabulary is matched against QUOTED literals ('%''elite''%')
// so a value cannot be satisfied by appearing inside the column name or
// inside another value.
//
// to_regclass() rather than the ::regclass cast throughout: the cast raises
// before any column is evaluated when the table is absent, which would report
// an unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.drills') is not null as drills_ready,
    (
      select count(*) = 10
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'drills'
        and column_name in (
          'organization_id', 'drill_id', 'name', 'category', 'focus',
          'cues', 'difficulty', 'active', 'created_at', 'updated_at'
        )
    ) as drill_columns_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'drills'
        and column_name = 'cues'
        and data_type = 'ARRAY'
    ) as drill_cues_array_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_drills_difficulty_check'
        and conrelid = to_regclass('pilot.drills')
        and pg_get_constraintdef(oid) like '%''beginner''%'
        and pg_get_constraintdef(oid) like '%''intermediate''%'
        and pg_get_constraintdef(oid) like '%''advanced''%'
        and pg_get_constraintdef(oid) like '%''elite''%'
    ) as drill_difficulty_vocabulary_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_drills_pkey'
        and conrelid = to_regclass('pilot.drills')
        and contype = 'p'
        and pg_get_constraintdef(oid) like '%(organization_id, drill_id)%'
    ) as drill_key_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.drills')
        and c.relname = 'pilot_drills_one_name_per_org'
        and i.indisunique
        and i.indpred is null
    ) as drill_name_unique_ready,
    exists (
      select 1
      from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_pilot_drills_org_active'
    ) as drill_library_index_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'drill_assignments'
        and column_name = 'drill_id'
        and is_nullable = 'YES'
    ) as assignment_drill_id_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_drill_assignments_fk_drill'
        and conrelid = to_regclass('pilot.drill_assignments')
        and confrelid = to_regclass('pilot.drills')
        and contype = 'f'
        and confdeltype = 'r'
        and pg_get_constraintdef(oid) like '%(organization_id, drill_id)%'
    ) as assignment_drill_fk_ready,
    exists (
      select 1
      from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_pilot_drill_assignments_drill'
    ) as assignment_drill_index_ready,
    (
      select count(*) = 2
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'drill_assignments'
        and column_name in ('drill_name', 'drill_description')
    ) as assignment_free_text_preserved
`;

// The readiness query asks eleven separate questions and names every one of
// them in its select list. Collapsing all eleven into a bare DRILLS_NOT_READY
// threw that away: `apply-migrations` (migration=all, target=staging) failed on
// this runner twice -- runs 31293202234 and 31337647625, seventeen hours apart
// -- and neither failure said which check was unmet, so neither was actionable.
// The information was already in the row; only the message was missing.
//
// Deliberately reports EVERY unmet check, not just the first: these are
// independent properties of the same table, so stopping at one would turn a
// single diagnosis into as many round trips as there are problems, and each
// round trip here is a workflow dispatch against a real database.
export function unmetReadinessChecks(row) {
  if (!row) return ['(the readiness query returned no row at all)'];
  return Object.entries(row)
    .filter(([, value]) => value !== true)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`);
}

function assertReadiness(row) {
  const unmet = unmetReadinessChecks(row);
  if (unmet.length > 0) {
    throw new Error(`DRILLS_NOT_READY -- unmet: ${unmet.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_drills_migration.sql',
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
  console.log(`Applied drills migration: ${migrationPath}`);
  console.log('PILOT DRILLS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT DRILLS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
