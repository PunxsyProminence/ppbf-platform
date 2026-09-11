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

// Asserts what the migration actually produced, not merely that it ran.
// to_regclass() rather than the ::regclass cast throughout: the cast raises
// before any column is evaluated when the table is absent, which would report an
// unmigrated database as a SQL error instead of as unreadiness.
//
// The parent table is checked FIRST and separately. This migration's composite
// foreign key is the only thing tying a relation to a real drill, and a database
// where pilot.drill_library is missing cannot have produced it -- so reporting
// "not ready" against the dependency is more useful than a constraint lookup
// that returns false for an unstated reason.
//
// THE PRIMARY-KEY SHAPE IS ASSERTED, NOT JUST ITS EXISTENCE. The uniqueness the
// owner asked for -- one relation per (organization, drill, skill) -- IS this
// key rather than a separate unique constraint. A primary key of any other shape
// would satisfy a name-only lookup while permitting duplicate relations, which
// is precisely the guarantee this table is supposed to carry.
const READINESS_QUERY = `
  select
    to_regclass('pilot.drill_library') is not null as drill_library_table_ready,
    to_regclass('pilot.drill_secondary_skills') is not null as drill_secondary_skills_table_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_secondary_skills_pkey'
        and conrelid = to_regclass('pilot.drill_secondary_skills')
        and contype = 'p'
        and pg_get_constraintdef(oid) like '%(organization_id, drill_id, skill_id)%'
    ) as drill_secondary_skills_pk_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_secondary_skills_drill_fk'
        and conrelid = to_regclass('pilot.drill_secondary_skills')
        and contype = 'f'
        and confrelid = to_regclass('pilot.drill_library')
        and pg_get_constraintdef(oid) like '%(organization_id, drill_id)%'
        and pg_get_constraintdef(oid) like '%ON DELETE CASCADE%'
    ) as drill_secondary_skills_drill_fk_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.drill_secondary_skills')
        and c.relname = 'pilot_drill_secondary_skills_skill'
    ) as drill_secondary_skills_skill_index_ready,
    -- The migration promises it does not touch the primary owner. A dispatch
    -- that found skill_id gone from drill_library has applied something other
    -- than what this file says it applies.
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'drill_library'
        and column_name = 'skill_id'
    ) as drill_library_primary_skill_intact
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('DRILL_SECONDARY_SKILLS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_drill_secondary_skills_migration.sql',
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
  console.log(`Applied drill secondary skills migration: ${migrationPath}`);
  console.log('PILOT DRILL SECONDARY SKILLS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT DRILL SECONDARY SKILLS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
