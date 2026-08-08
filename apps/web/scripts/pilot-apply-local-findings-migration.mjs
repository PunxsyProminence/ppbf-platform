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

const READINESS_QUERY = `
  select
    to_regclass('pilot.local_findings') is not null as local_findings_table_ready,
    to_regclass('pilot.local_finding_tier_history') is not null as tier_history_table_ready,
    to_regclass('pilot.v_evidence_combined') is not null as evidence_combined_view_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_local_findings_tested'
        and conrelid = to_regclass('pilot.local_findings')
    ) as local_findings_tested_check_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_local_findings_reviewed'
        and conrelid = to_regclass('pilot.local_findings')
    ) as local_findings_reviewed_check_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_local_findings_contradiction'
        and conrelid = to_regclass('pilot.local_findings')
        and pg_get_constraintdef(oid) like '%20%'
    ) as local_findings_contradiction_check_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_lfth_rationale'
        and conrelid = to_regclass('pilot.local_finding_tier_history')
    ) as tier_history_rationale_check_ready,
    coalesce((
      select reloptions @> array['security_invoker=true']
      from pg_class where oid = to_regclass('pilot.v_evidence_combined')
    ), false) as evidence_combined_security_invoker_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('LOCAL_FINDINGS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_local_findings_migration.sql',
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
  console.log(`Applied local findings migration: ${migrationPath}`);
  console.log('PILOT LOCAL FINDINGS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT LOCAL FINDINGS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
