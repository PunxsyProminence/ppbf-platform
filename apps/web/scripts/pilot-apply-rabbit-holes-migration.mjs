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
// name is present. A lesson is anchored to a vocabulary value, so an
// environment carrying the table with a stale anchor_type list silently refuses
// whole categories of lesson -- that is the failure this check exists to catch,
// and a name-only check would pass straight through it.
//
// TWO OF THESE ASSERT AN ABSENCE, because two of this migration's decisions are
// decisions NOT to constrain:
//
//   * `anchor_key_unowned_ready` -- anchor_key holds values from eight
//     vocabularies at once, so any CHECK mentioning it is wrong by
//     construction. The writing code owns key validity.
//   * `library_reference_unbound_ready` -- no foreign key from this table to
//     pilot.shadow_library_documents. Approval is revocable and library
//     takedown must never be blocked by, or destroy, an authored lesson, so
//     the reference is resolved by the read's approval predicate instead. An
//     environment where somebody added the key back is not ready.
//
// `published_anchor_index_ready` requires indpred is not null: a non-partial
// index of the same name would pass a name-only check while carrying every
// retired lesson the reader will never be shown.
//
// to_regclass() rather than the ::regclass cast throughout: the cast raises
// before any column is evaluated when the table is absent, which would report
// an unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.rabbit_holes') is not null as rabbit_holes_ready,
    (
      select count(*) = 14
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'rabbit_holes'
        and column_name in (
          'organization_id', 'rabbit_hole_id', 'anchor_type', 'anchor_key',
          'audience', 'title', 'concept', 'homework', 'library_document_id',
          'author_account_id', 'author_display_name', 'status',
          'created_at', 'updated_at'
        )
    ) as rabbit_hole_columns_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'rabbit_holes'
        and column_name = 'homework'
        and is_nullable = 'YES'
    ) as optional_homework_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_rabbit_holes_anchor_type_check'
        and conrelid = to_regclass('pilot.rabbit_holes')
        and pg_get_constraintdef(oid) like '%''gap_type''%'
        and pg_get_constraintdef(oid) like '%''severity''%'
        and pg_get_constraintdef(oid) like '%''formula_id''%'
        and pg_get_constraintdef(oid) like '%''board_seat''%'
        and pg_get_constraintdef(oid) like '%''evidence_tier''%'
        and pg_get_constraintdef(oid) like '%''readiness_band''%'
        and pg_get_constraintdef(oid) like '%''compliance_rule''%'
        and pg_get_constraintdef(oid) like '%''drill''%'
    ) as anchor_vocabulary_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_rabbit_holes_audience_check'
        and conrelid = to_regclass('pilot.rabbit_holes')
        and pg_get_constraintdef(oid) like '%''all''%'
        and pg_get_constraintdef(oid) like '%''platform_owner''%'
        and pg_get_constraintdef(oid) like '%''organization_admin''%'
        and pg_get_constraintdef(oid) like '%''admin''%'
        and pg_get_constraintdef(oid) like '%''coach''%'
        and pg_get_constraintdef(oid) like '%''athlete''%'
        and pg_get_constraintdef(oid) like '%''parent''%'
        and pg_get_constraintdef(oid) like '%''board''%'
        and pg_get_constraintdef(oid) like '%''volunteer''%'
        and pg_get_constraintdef(oid) like '%''staff''%'
    ) as audience_vocabulary_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_rabbit_holes_status_check'
        and conrelid = to_regclass('pilot.rabbit_holes')
        and pg_get_constraintdef(oid) like '%''published''%'
        and pg_get_constraintdef(oid) like '%''retired''%'
    ) as status_vocabulary_ready,
    exists (
      select 1
      from pg_constraint
      where conname = 'pilot_rabbit_holes_pkey'
        and conrelid = to_regclass('pilot.rabbit_holes')
        and contype = 'p'
        and pg_get_constraintdef(oid) like '%(organization_id, rabbit_hole_id)%'
    ) as lesson_key_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.rabbit_holes')
        and c.relname = 'idx_pilot_rabbit_holes_published_anchor'
        and i.indpred is not null
    ) as published_anchor_index_ready,
    (
      to_regclass('pilot.rabbit_holes') is not null
      and not exists (
        select 1
        from pg_constraint
        where conrelid = to_regclass('pilot.rabbit_holes')
          and contype = 'c'
          and pg_get_constraintdef(oid) like '%anchor_key%'
      )
    ) as anchor_key_unowned_ready,
    (
      to_regclass('pilot.rabbit_holes') is not null
      and not exists (
        select 1
        from pg_constraint
        where conrelid = to_regclass('pilot.rabbit_holes')
          and contype = 'f'
          and confrelid = to_regclass('pilot.shadow_library_documents')
      )
    ) as library_reference_unbound_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('RABBIT_HOLES_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_rabbit_holes_migration.sql',
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
  console.log(`Applied rabbit holes migration: ${migrationPath}`);
  console.log('PILOT RABBIT HOLES MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT RABBIT HOLES MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
