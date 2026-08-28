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

// Asserts what the migration actually produced. to_regclass() rather than
// the ::regclass cast throughout: the cast raises before any column is
// evaluated when the table is absent, which would report an unmigrated
// database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.drill_library') is not null as drill_library_table_ready,
    to_regclass('pilot.drill_scale_levels') is not null as drill_scale_levels_table_ready,
    to_regclass('pilot.drill_stop_rules') is not null as drill_stop_rules_table_ready,
    to_regclass('pilot.drill_cues') is not null as drill_cues_table_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'drill_library'
        and column_name = 'grounding_claim_ids' and data_type = 'ARRAY'
    ) as drill_library_grounding_claim_ids_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_library_field_provenance_check'
        and conrelid = to_regclass('pilot.drill_library')
        and pg_get_constraintdef(oid) like '%''PPBF source manual v3''%'
        and pg_get_constraintdef(oid) like '%''LITERATURE-GROUNDED DRAFT%'
        and pg_get_constraintdef(oid) like '%''COACHING-CRAFT DRAFT%'
    ) as drill_library_field_provenance_vocabulary_ready,
    -- THE DISCIPLINE COLUMN IS GOVERNED BY SOMETHING. This used to assert the
    -- literal CHECK and its vocabulary outright. It cannot any more: the owner
    -- decided on 2026-08-28, verbatim, "drop the check and let the registry
    -- govern", and the drill-library-check-drop migration removes
    -- pilot_drill_library_discipline_check once
    -- pilot_drill_library_discipline_fk is installed. Left as it was, this
    -- clause would have turned every "all" dispatch after that drop red, in the
    -- migration that creates half the drill schema.
    --
    -- What replaces it is the property the CHECK was standing in for, stated
    -- once and for both eras: the column is governed by the registry key, or --
    -- before that key exists -- by the five-literal CHECK. It is deliberately
    -- an OR and not a weakening: if BOTH are absent the column is free text and
    -- this returns false, which is the state no dispatch may report as ready.
    (
      exists (
        select 1 from pg_constraint
        where conname = 'pilot_drill_library_discipline_fk'
          and conrelid = to_regclass('pilot.drill_library')
          and contype = 'f'
          and confrelid = to_regclass('pilot.disciplines')
      )
      or exists (
        select 1 from pg_constraint
        where conname = 'pilot_drill_library_discipline_check'
          and conrelid = to_regclass('pilot.drill_library')
          and pg_get_constraintdef(oid) like '%''boxing''%'
          and pg_get_constraintdef(oid) like '%''wrestling''%'
          and pg_get_constraintdef(oid) like '%''combatives''%'
      )
    ) as drill_library_discipline_governed,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_library_difficulty_check'
        and conrelid = to_regclass('pilot.drill_library')
        and pg_get_constraintdef(oid) like '%''beginner''%'
        and pg_get_constraintdef(oid) like '%''elite''%'
    ) as drill_library_difficulty_vocabulary_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_library_supersedes_fk'
        and conrelid = to_regclass('pilot.drill_library')
        and contype = 'f'
        and pg_get_constraintdef(oid) like '%(organization_id, supersedes_drill_id)%'
    ) as drill_library_supersedes_fk_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.drill_library')
        and c.relname = 'pilot_drill_library_one_active_name'
        and i.indisunique
        and i.indpred is not null
    ) as drill_library_one_active_name_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.drill_scale_levels')
        and c.relname = 'pilot_drill_scale_one_start'
        and i.indisunique
        and i.indpred is not null
    ) as drill_scale_one_start_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.drill_scale_levels')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%is_starting_point%'
        and pg_get_constraintdef(oid) like '%scale_level%'
    ) as drill_scale_start_must_be_b_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_scale_pkey'
        and conrelid = to_regclass('pilot.drill_scale_levels')
        and contype = 'p'
    ) as drill_scale_levels_pk_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.drill_scale_levels')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%scale_level%'
        and pg_get_constraintdef(oid) like '%''A''%'
        and pg_get_constraintdef(oid) like '%''B''%'
        and pg_get_constraintdef(oid) like '%''C''%'
    ) as drill_scale_levels_vocabulary_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.drill_stop_rules')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%rule_kind%'
        and pg_get_constraintdef(oid) like '%''coach_judgment''%'
    ) as drill_stop_rules_vocabulary_ready,
    exists (
      select 1 from pg_constraint
      where conrelid = to_regclass('pilot.drill_cues')
        and contype = 'c'
        and pg_get_constraintdef(oid) like '%focus_type%'
        and pg_get_constraintdef(oid) like '%''constraint''%'
    ) as drill_cues_focus_type_vocabulary_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('DRILL_LIBRARY_V3_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_drill_library_v3_migration.sql',
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
  console.log(`Applied drill library v3 migration: ${migrationPath}`);
  console.log('PILOT DRILL LIBRARY V3 MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT DRILL LIBRARY V3 MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
