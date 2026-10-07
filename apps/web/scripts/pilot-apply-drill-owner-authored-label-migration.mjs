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

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

// Readiness asserts the label is actually in the CHECK, that the three old
// values are still there, and that exactly one CHECK governs the column. A
// migration that dropped the old constraint and failed to add the new one
// would leave field_provenance unconstrained -- strictly worse than the narrow
// list it replaced -- and a name-only check would call that success.
const READINESS_QUERY = `
  select
    to_regclass('pilot.drill_library') is not null as drill_library_table_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_library_field_provenance_check'
        and conrelid = to_regclass('pilot.drill_library')
        and pg_get_constraintdef(oid) like '%PPBF owner-authored%'
        and pg_get_constraintdef(oid) like '%PPBF source manual v3%'
        and pg_get_constraintdef(oid) like '%LITERATURE-GROUNDED DRAFT%'
        and pg_get_constraintdef(oid) like '%COACHING-CRAFT DRAFT%'
    ) as field_provenance_widened,
    (
      select count(*) from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      where nsp.nspname = 'pilot' and rel.relname = 'drill_library'
        and con.contype = 'c' and pg_get_constraintdef(con.oid) ilike '%field_provenance%'
    ) = 1 as field_provenance_single_check
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('DRILL_OWNER_AUTHORED_LABEL_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_drill_owner_authored_label_migration.sql',
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
  console.log(`Applied drill owner-authored label migration: ${migrationPath}`);
  console.log('PILOT DRILL OWNER-AUTHORED LABEL MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT DRILL OWNER-AUTHORED LABEL MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
