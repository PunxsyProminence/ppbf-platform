import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the film-study-revisions migration inside one transaction, with the same
// target-verification discipline as every other pilot:apply-* script: the
// operator must state which host and database they believe they are
// pointing at, and a mismatch refuses before any DDL runs.

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
    to_regclass('pilot.film_study_proposal_revisions') is not null as table_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.film_study_proposal_revisions')
        and conname = 'pilot_film_revisions_unique_number'
    ) as revision_ordering_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'film_study_proposal_revisions'
        and column_name = 'revised_by_account_id'
        and is_nullable = 'NO'
    ) as attribution_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_film_revisions_by_proposal'
    ) as history_index_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_film_revisions_by_org'
    ) as org_index_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.shadow_film_study_proposals')
        and conname = 'pilot_film_study_proposals_correction_check_v2'
    ) as correction_check_widened
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('FILM_STUDY_REVISIONS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_film_study_revisions_migration.sql',
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
  console.log(`Applied film study revisions migration: ${migrationPath}`);
  console.log('PILOT FILM STUDY REVISIONS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT FILM STUDY REVISIONS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
