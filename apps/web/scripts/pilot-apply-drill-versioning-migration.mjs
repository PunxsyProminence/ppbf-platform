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

// Asserts what the migration actually produced, not merely that a name is
// present. Three checks measure a property a name-only check would pass
// while the migration's whole point was missing:
//
// `drills_name_partial_unique_ready` asserts pilot_drills_one_name_per_org
// is UNIQUE AND PARTIAL (indpred is NOT null) -- the opposite of what the
// drills migration's own runner asserts, because this migration's entire
// point on that index is to relax it from total to active-only. A database
// still carrying the OLD total index would silently refuse every
// refinement, which is the traceability gap this migration exists to close.
//
// `drills_lineage_trigger_ready` asserts the BEFORE INSERT trigger exists,
// not merely that the lineage_id column does -- a column with no trigger
// would refuse every insert that does not name a lineage explicitly,
// breaking drills.ts#createDrill's unmodified INSERT.
//
// `change_proposals_resulting_pairing_ready` and
// `version_outcomes_computed_by_vocabulary_ready` are matched against
// QUOTED literals so a value cannot be satisfied by appearing inside the
// column name or inside another value, matching the drills runner's own
// difficulty-vocabulary check.
//
// to_regclass() rather than the ::regclass cast throughout: the cast raises
// before any column is evaluated when the table is absent, which would
// report an unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'drills'
        and column_name = 'version' and is_nullable = 'NO' and data_type = 'integer'
    ) as drills_version_column_ready,
    exists (
      select 1 from information_schema.columns
      where table_schema = 'pilot' and table_name = 'drills'
        and column_name = 'lineage_id' and is_nullable = 'NO'
    ) as drills_lineage_column_ready,
    (
      select count(*) = 3
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'drills'
        and column_name in ('supersedes_drill_id', 'superseded_at', 'superseded_by_drill_id')
        and is_nullable = 'YES'
    ) as drills_supersedes_columns_ready,
    exists (
      select 1 from pg_trigger
      where tgname = 'pilot_drills_default_lineage_id'
        and tgrelid = to_regclass('pilot.drills')
    ) as drills_lineage_trigger_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drills_version_positive_check'
        and conrelid = to_regclass('pilot.drills')
    ) as drills_version_check_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drills_supersedes_not_self_check'
        and conrelid = to_regclass('pilot.drills')
    ) as drills_supersedes_not_self_check_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drills_supersedes_fk'
        and conrelid = to_regclass('pilot.drills')
        and contype = 'f'
        and pg_get_constraintdef(oid) like '%(organization_id, supersedes_drill_id)%'
    ) as drills_supersedes_fk_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drills_superseded_by_fk'
        and conrelid = to_regclass('pilot.drills')
        and contype = 'f'
        and pg_get_constraintdef(oid) like '%(organization_id, superseded_by_drill_id)%'
    ) as drills_superseded_by_fk_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.drills')
        and c.relname = 'pilot_drills_lineage_version_uq'
        and i.indisunique
    ) as drills_lineage_version_unique_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.drills')
        and c.relname = 'pilot_drills_one_name_per_org'
        and i.indisunique
        and i.indpred is not null
    ) as drills_name_partial_unique_ready,
    to_regclass('pilot.drill_change_proposals') is not null as change_proposals_table_ready,
    (
      select count(*) = 16
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'drill_change_proposals'
        and column_name in (
          'proposal_id', 'organization_id', 'lineage_id', 'based_on_drill_id',
          'proposed_by_account_id', 'proposed_by_role', 'rationale', 'proposed_change',
          'observation_note_ids', 'review_state', 'reviewed_by_account_id', 'reviewed_at',
          'review_note', 'resulting_drill_id', 'created_at', 'updated_at'
        )
    ) as change_proposals_columns_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_change_proposals_review_state_check'
        and conrelid = to_regclass('pilot.drill_change_proposals')
        and pg_get_constraintdef(oid) like '%''proposed''%'
        and pg_get_constraintdef(oid) like '%''under_review''%'
        and pg_get_constraintdef(oid) like '%''adopted''%'
        and pg_get_constraintdef(oid) like '%''declined''%'
        and pg_get_constraintdef(oid) like '%''superseded''%'
    ) as change_proposals_review_state_vocabulary_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_change_proposals_resulting_pairing_check'
        and conrelid = to_regclass('pilot.drill_change_proposals')
    ) as change_proposals_resulting_pairing_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot' and indexname = 'idx_pilot_drill_change_proposals_org_state'
    ) as change_proposals_state_index_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot' and indexname = 'idx_pilot_drill_change_proposals_org_lineage'
    ) as change_proposals_lineage_index_ready,
    to_regclass('pilot.drill_version_outcomes') is not null as version_outcomes_table_ready,
    (
      select count(*) = 12
      from information_schema.columns
      where table_schema = 'pilot' and table_name = 'drill_version_outcomes'
        and column_name in (
          'outcome_id', 'organization_id', 'drill_id', 'lineage_id', 'window_start', 'window_end',
          'assignments_count', 'completion_rate', 'coach_rating_mean', 'observation_count',
          'computed_at', 'computed_by'
        )
    ) as version_outcomes_columns_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_version_outcomes_computed_by_check'
        and conrelid = to_regclass('pilot.drill_version_outcomes')
        and pg_get_constraintdef(oid) like '%''scheduled_job''%'
        and pg_get_constraintdef(oid) like '%''manual''%'
    ) as version_outcomes_computed_by_vocabulary_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_version_outcomes_window_uq'
        and conrelid = to_regclass('pilot.drill_version_outcomes')
        and contype = 'u'
    ) as version_outcomes_window_unique_ready,
    exists (
      select 1 from pg_indexes
      where schemaname = 'pilot' and indexname = 'idx_pilot_drill_version_outcomes_org_lineage'
    ) as version_outcomes_index_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('DRILL_VERSIONING_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_drill_versioning_migration.sql',
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
  console.log(`Applied drill versioning migration: ${migrationPath}`);
  console.log('PILOT DRILL VERSIONING MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT DRILL VERSIONING MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
