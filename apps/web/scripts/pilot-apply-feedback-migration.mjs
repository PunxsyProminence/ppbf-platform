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
// name is present. Every property below is one a feedback box could lack while
// still accepting inserts, and each of them is a safeguarding failure:
//
// `route_stored_ready` asserts route is NOT NULL and has NO column default. A
// default is the whole hazard in one word -- with one, a writer that forgot to
// decide silently files a child's disclosure into the product backlog, and
// nothing anywhere reports an error.
//
// `freeze_trigger_ready` asserts the trigger is row-level (tgtype & 1) and
// BEFORE (& 2) on UPDATE (& 16); a trigger by that name attached to the wrong
// event would pass a name-only check and reclassification would go through.
//
// `safeguarding_queue_index_ready` matches the whole column list including
// `created_at DESC`, because an index on the first three columns only would
// satisfy a name check and still leave the queue sorting by hand.
//
// to_regclass() rather than the ::regclass cast throughout: the cast raises
// before any column is evaluated when the table is absent, which would report
// an unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.feedback_submissions') is not null as feedback_submissions_ready,
    (
      select count(*) = 13
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'feedback_submissions'
        and column_name in (
          'submission_id', 'organization_id', 'submitted_by_account_id',
          'submitted_by_role', 'kind', 'body', 'route', 'triage_status',
          'triage_note', 'triaged_by_account_id', 'triaged_at',
          'created_at', 'updated_at'
        )
    ) as feedback_columns_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'feedback_submissions'
        and column_name = 'route'
        and is_nullable = 'NO'
        and column_default is null
    ) as route_stored_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_feedback_submissions_kind_check'
        and conrelid = to_regclass('pilot.feedback_submissions')
        and pg_get_constraintdef(oid) like '%''bug''%'
        and pg_get_constraintdef(oid) like '%''idea''%'
        and pg_get_constraintdef(oid) like '%''frustration''%'
        and pg_get_constraintdef(oid) like '%''other''%'
    ) as kind_vocabulary_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_feedback_submissions_route_check'
        and conrelid = to_regclass('pilot.feedback_submissions')
        and pg_get_constraintdef(oid) like '%''product''%'
        and pg_get_constraintdef(oid) like '%''safeguarding''%'
    ) as route_vocabulary_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_feedback_submissions_triage_status_check'
        and conrelid = to_regclass('pilot.feedback_submissions')
        and pg_get_constraintdef(oid) like '%''new''%'
        and pg_get_constraintdef(oid) like '%''triaged''%'
        and pg_get_constraintdef(oid) like '%''planned''%'
        and pg_get_constraintdef(oid) like '%''declined''%'
        and pg_get_constraintdef(oid) like '%''done''%'
    ) as triage_status_vocabulary_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_feedback_submissions_role_check'
        and conrelid = to_regclass('pilot.feedback_submissions')
        and pg_get_constraintdef(oid) like '%''athlete''%'
        and pg_get_constraintdef(oid) like '%''parent''%'
        and pg_get_constraintdef(oid) like '%''coach''%'
    ) as submitter_role_vocabulary_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_feedback_submissions_body_present_check'
        and conrelid = to_regclass('pilot.feedback_submissions')
    ) as body_present_ready,
    exists (
      select 1
      from pg_trigger
      where tgrelid = to_regclass('pilot.feedback_submissions')
        and tgname = 'pilot_feedback_submissions_freeze_disclosure'
        and not tgisinternal
        and (tgtype::int & 19) = 19
    ) as freeze_trigger_ready,
    exists (
      select 1
      from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_pilot_feedback_submissions_route_queue'
        and indexdef like '%(organization_id, route, triage_status, created_at DESC)%'
    ) as safeguarding_queue_index_ready,
    exists (
      select 1
      from pg_indexes
      where schemaname = 'pilot'
        and indexname = 'idx_pilot_feedback_submissions_submitter'
    ) as submitter_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('FEEDBACK_SUBMISSIONS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_feedback_migration.sql',
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
  console.log(`Applied feedback submissions migration: ${migrationPath}`);
  console.log('PILOT FEEDBACK MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT FEEDBACK MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
