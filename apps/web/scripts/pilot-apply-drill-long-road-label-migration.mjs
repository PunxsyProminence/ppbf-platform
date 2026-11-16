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

// Readiness asserts the label is actually in the CHECK, that the four older
// values are still there, and that exactly one CHECK governs the column. A
// migration that dropped the old constraint and failed to add the new one
// would leave field_provenance unconstrained -- strictly worse than the
// narrower list it replaced -- and a name-only check would call that success.
// Quoted literals with strpos, not LIKE: 'PPBF owner-authored' must match as a
// whole value, and no value is read as a pattern.
const READINESS_QUERY = `
  select
    to_regclass('pilot.drill_library') is not null as drill_library_table_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_library_field_provenance_check'
        and conrelid = to_regclass('pilot.drill_library')
        and contype = 'c'
        and strpos(pg_get_constraintdef(oid), quote_literal('Long Road practice')) > 0
        and strpos(pg_get_constraintdef(oid), quote_literal('PPBF owner-authored')) > 0
        and strpos(pg_get_constraintdef(oid), quote_literal('PPBF source manual v3')) > 0
        and strpos(pg_get_constraintdef(oid), quote_literal('LITERATURE-GROUNDED DRAFT — generated from cited registry claims; REQUIRES FLOOR VALIDATION')) > 0
        and strpos(pg_get_constraintdef(oid), quote_literal('COACHING-CRAFT DRAFT — no directly relevant research retrieved; REQUIRES FLOOR VALIDATION')) > 0
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
    throw new Error('DRILL_LONG_ROAD_LABEL_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_drill_long_road_label_migration.sql',
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
  console.log(`Applied drill Long Road label migration: ${migrationPath}`);
  console.log('PILOT DRILL LONG ROAD LABEL MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT DRILL LONG ROAD LABEL MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
