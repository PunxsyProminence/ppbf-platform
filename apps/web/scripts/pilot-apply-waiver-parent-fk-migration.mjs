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

// Asserts the properties the migration exists for, not merely that a
// constraint by that name is present -- a constraint by that name was ALREADY
// present before this migration, in the shape that is the defect.
//
// `fk_scoped_to_parent_id` is the whole point. confdeltype = 'n' says SET
// NULL; confdelsetcols says WHICH columns, and is null for the broken
// whole-key form. The attnum is resolved from pg_attribute rather than
// hard-coded, because a column's attnum is an implementation detail that
// shifts if the table is ever rebuilt -- pinning the number would make this
// assertion quietly wrong rather than loudly.
//
// `organization_id_still_not_null` is the fail-closed half, and it guards
// against a fix nobody should make. Faced with `23502: null value in column
// "organization_id"`, the reflex is to make that column nullable. Every
// projection, gate and index in this schema keys on organization_id, so that
// would trade a failed delete for a tenancy hole. This refuses such a database
// instead of reporting success on it.
//
// `parent_id_still_nullable` because SET NULL on a NOT NULL column cannot
// work: a later edit tightening parent_id would leave a constraint that raises
// the moment it fires, which is the state this migration exists to end.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// row is evaluated when the table is absent, which would report an unmigrated
// database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.waivers') is not null as table_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_waivers_parent_fk'
        and conrelid = to_regclass('pilot.waivers')
        and contype = 'f'
        and confdeltype = 'n'
    ) as fk_set_null_ready,
    exists (
      select 1
      from pg_constraint c
      where c.conname = 'pilot_waivers_parent_fk'
        and c.conrelid = to_regclass('pilot.waivers')
        and c.confdelsetcols = array[(
          select a.attnum
          from pg_attribute a
          where a.attrelid = to_regclass('pilot.waivers')
            and a.attname = 'parent_id'
        )]::int2[]
    ) as fk_scoped_to_parent_id,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'waivers'
        and column_name = 'organization_id'
        and is_nullable = 'NO'
    ) as organization_id_still_not_null,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'waivers'
        and column_name = 'parent_id'
        and is_nullable = 'YES'
    ) as parent_id_still_nullable
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('WAIVER_PARENT_FK_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_waiver_parent_fk_migration.sql',
  );

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  try {
    // Reported before the work, because the migration refuses below PostgreSQL
    // 15 and the version this server runs is not recorded anywhere in the
    // repository. A dispatch that fails should say what it was talking to.
    const version = await client.query('show server_version_num');
    console.log(`server_version_num: ${version.rows[0]?.server_version_num ?? 'unreadable'}`);
    await applyMigrationTransaction(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied waiver parent foreign-key migration: ${migrationPath}`);
  console.log('PILOT WAIVER PARENT FK MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT WAIVER PARENT FK MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
