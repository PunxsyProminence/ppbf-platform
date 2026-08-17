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

const READINESS_QUERY = `
  select
    to_regclass('pilot.safety_escalations') is not null as safety_escalations_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.safety_escalations')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%''near_miss''%'
        and pg_get_constraintdef(oid) like '%''pain_report''%'
        and pg_get_constraintdef(oid) like '%''safety_gate_evaluation''%'
        and pg_get_constraintdef(oid) like '%''repeated_pattern''%'
        and pg_get_constraintdef(oid) like '%''athlete_voice''%'
        and pg_get_constraintdef(oid) like '%''training_hold''%'
        and pg_get_constraintdef(oid) like '%''incident''%'
        and pg_get_constraintdef(oid) like '%''video_scan''%'
    ) as source_type_vocabulary_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.safety_escalations')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%''coach''%'
        and pg_get_constraintdef(oid) like '%''organization_admin''%'
        and pg_get_constraintdef(oid) not like '%''board''%'
    ) as escalated_to_role_vocabulary_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('SAFETY_ESCALATIONS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_safety_escalations_migration.sql',
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
  console.log(`Applied safety escalations migration: ${migrationPath}`);
  console.log('PILOT SAFETY ESCALATIONS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SAFETY ESCALATIONS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
