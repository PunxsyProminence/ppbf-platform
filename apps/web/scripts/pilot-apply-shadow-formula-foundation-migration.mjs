// Applies the SHADOW formula foundation migration.
//
// Unreachable until 2026-08-01. formulas/repository.ts reads and writes every
// column below, including the idempotency_key it uses to avoid recording the
// same observation twice.
//
// This migration's SQL opens and closes its own transaction, so this runner
// deliberately does NOT wrap it in one. Issuing BEGIN around a self-transacting
// migration nests the transaction: the migration's own COMMIT ends it, a
// trailing COMMIT here warns that none is in progress, and -- the part that
// matters -- a ROLLBACK after a failed readiness check would silently do
// nothing, because the work is already committed. The readiness assertion below
// is therefore a post-commit verification that fails the run loudly, not a gate
// that can undo it.
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

// All three formula tables, because the migration spreads its columns across
// them and a partial application leaves the repository reading columns that
// exist on one table and not its sibling.
const READINESS_QUERY = `
  select
    (
      select count(*) = 2
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_formula_observations'
        and column_name in ('dimensions', 'idempotency_key')
    ) as formula_observations_columns_ready,
    (
      select count(*) = 4
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_formula_results'
        and column_name in ('calculation_key', 'output_key', 'policy_version', 'parameters')
    ) as formula_results_columns_ready,
    (
      select count(*) = 5
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_formula_baseline_snapshots'
        and column_name in ('calculation_key', 'metric_key', 'unit', 'policy_version', 'parameters')
    ) as formula_baseline_snapshots_columns_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('SHADOW_FORMULA_FOUNDATION_NOT_READY');
  }
}

export async function applyMigration(client, sql) {
  await client.query(sql);
  const readiness = await client.query(READINESS_QUERY);
  assertReadiness(readiness.rows[0]);
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
    '../../../infra/azure/pilot_slice_postgres_shadow_formula_foundation_migration.sql',
  );

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  try {
    await applyMigration(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied SHADOW formula foundation migration: ${migrationPath}`);
  console.log('PILOT SHADOW FORMULA FOUNDATION MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SHADOW FORMULA FOUNDATION MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
