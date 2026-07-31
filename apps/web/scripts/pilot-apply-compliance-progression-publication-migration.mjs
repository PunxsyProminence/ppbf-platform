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

// Asserts all nine tables plus the columns the three server modules actually
// write, not merely that the tables exist. The volunteers outage is the reason
// for the column-level check: pilot.volunteers existed the whole time the
// feature was broken -- it was the columns that were missing.
const READINESS_QUERY = `
  select
    to_regclass('pilot.compliance_rules') is not null as compliance_rules_ready,
    to_regclass('pilot.compliance_violations') is not null as compliance_violations_ready,
    to_regclass('pilot.violation_escalations') is not null as violation_escalations_ready,
    to_regclass('pilot.progression_gaps') is not null as progression_gaps_ready,
    to_regclass('pilot.drill_assignments') is not null as drill_assignments_ready,
    to_regclass('pilot.assignment_completions') is not null as assignment_completions_ready,
    to_regclass('pilot.video_publications') is not null as video_publications_ready,
    to_regclass('pilot.publication_checks') is not null as publication_checks_ready,
    to_regclass('pilot.research_library') is not null as research_library_ready,
    (
      select count(*) = 3
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'compliance_violations'
        and column_name in ('escalation_status', 'violation_timestamp', 'evidence_path')
    ) as violation_columns_ready,
    (
      select count(*) = 3
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'drill_assignments'
        and column_name in ('completion_percentage', 'frequency_per_week', 'due_date')
    ) as assignment_columns_ready,
    (
      select count(*) = 2
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'video_publications'
        and column_name in ('compliance_check_status', 'metadata_complete')
    ) as publication_columns_ready,
    (
      select count(*) = 2
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'research_library'
        and column_name in ('view_count', 'citation_count')
    ) as library_columns_ready,
    exists (
      select 1
      from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_compliance_violations_org_athlete'
    ) as violation_index_ready,
    exists (
      select 1
      from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_research_library_published'
    ) as library_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('COMPLIANCE_PROGRESSION_PUBLICATION_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_compliance_progression_publication_migration.sql',
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
  console.log(`Applied compliance/progression/publication migration: ${migrationPath}`);
  console.log('PILOT COMPLIANCE PROGRESSION PUBLICATION MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT COMPLIANCE PROGRESSION PUBLICATION MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
