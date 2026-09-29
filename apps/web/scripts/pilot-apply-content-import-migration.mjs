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

// Asserts what the migration PROMISED, by shape, not that a statement ran.
//
// to_regclass()/to_regprocedure() rather than casts, as in the sibling
// runners: a cast raises before any column is evaluated when the object is
// absent, which would report an unmigrated database as a SQL error instead of
// as unreadiness.
//
// Shape rather than name, because the central change here KEEPS a name:
// pilot_drill_library_one_active_name exists before this migration too, with
// the predicate this migration replaces. The v3 runner's own assertion
// ("unique and partial", pilot-apply-drill-library-v3-migration.mjs:123-131)
// and pilot-verify-schema.mjs (names only) both pass either shape. So:
//   * the name index is unique, on (organization_id, discipline, name), and
//     its predicate names superseded_at -- the old one would fail here
//   * each lineage-head index is unique on (organization_id, lineage_id) and
//     partial on superseded_at is null
//   * the universal rule_kind CHECK deparses IDENTICALLY to the widened
//     drill_stop_rules one. The migration defines them as the same
//     vocabulary; a later widening of one without the other turns the next
//     dispatch red instead of letting the two drift
//   * the ledger's trigger is enabled and fires BEFORE, per ROW, on both
//     UPDATE and DELETE (tgtype bits 2, 1, 16 and 8) and calls the append-only
//     function -- a trigger that watched only UPDATE would still accept a
//     DELETE of history
//   * the drill_stop_rules comment no longer calls the per-drill rows the
//     universal rules
const READINESS_QUERY = `
  select
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.drill_library')
        and c.relname = 'pilot_drill_library_one_active_name'
        and i.indisunique
        and pg_get_indexdef(i.indexrelid) like '%(organization_id, discipline, name)%'
        and pg_get_expr(i.indpred, i.indrelid) like '%active%'
        and pg_get_expr(i.indpred, i.indrelid) like '%superseded_at IS NULL%'
    ) as drill_name_index_current_only,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.drill_library')
        and c.relname = 'pilot_drill_library_one_head_per_lineage'
        and i.indisunique
        and pg_get_indexdef(i.indexrelid) like '%(organization_id, lineage_id)%'
        and pg_get_expr(i.indpred, i.indrelid) = '(superseded_at IS NULL)'
    ) as drill_one_head_per_lineage_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.workout_templates')
        and c.relname = 'pilot_workout_templates_one_head_per_lineage'
        and i.indisunique
        and pg_get_indexdef(i.indexrelid) like '%(organization_id, lineage_id)%'
        and pg_get_expr(i.indpred, i.indrelid) = '(superseded_at IS NULL)'
    ) as template_one_head_per_lineage_ready,
    to_regclass('pilot.universal_stop_rules') is not null as universal_stop_rules_table_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_universal_stop_rules_pkey'
        and conrelid = to_regclass('pilot.universal_stop_rules')
        and contype = 'p'
        and pg_get_constraintdef(oid) = 'PRIMARY KEY (organization_id, universal_rule_id)'
    ) as universal_pk_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_universal_stop_rules_lineage_version_uq'
        and conrelid = to_regclass('pilot.universal_stop_rules')
        and contype = 'u'
        and pg_get_constraintdef(oid) = 'UNIQUE (organization_id, lineage_id, version)'
    ) as universal_lineage_version_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_universal_stop_rules_supersedes_fk'
        and conrelid = to_regclass('pilot.universal_stop_rules')
        and contype = 'f'
        and confrelid = to_regclass('pilot.universal_stop_rules')
        and pg_get_constraintdef(oid) like '%(organization_id, supersedes_rule_id)%'
    ) as universal_supersedes_fk_ready,
    exists (
      select 1
      from pg_constraint u
      join pg_constraint d
        on d.conname = 'pilot_drill_stop_rule_kind_check'
       and d.conrelid = to_regclass('pilot.drill_stop_rules')
      where u.conname = 'pilot_universal_stop_rules_rule_kind_check'
        and u.conrelid = to_regclass('pilot.universal_stop_rules')
        and pg_get_constraintdef(u.oid) = pg_get_constraintdef(d.oid)
    ) as universal_rule_kind_matches_drill_stop_rules,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_universal_stop_rules_contact_levels_check'
        and conrelid = to_regclass('pilot.universal_stop_rules')
        and pg_get_constraintdef(oid) like '%applies_to_contact_levels%'
        and pg_get_constraintdef(oid) like '%''open_sparring''%'
    ) as universal_contact_levels_check_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_universal_stop_rules_condition_check'
        and conrelid = to_regclass('pilot.universal_stop_rules')
        and pg_get_constraintdef(oid) like '%condition_text%'
    ) as universal_condition_check_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_universal_stop_rules_id_check'
        and conrelid = to_regclass('pilot.universal_stop_rules')
        and pg_get_constraintdef(oid) like '%^ust_%'
    ) as universal_id_check_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.universal_stop_rules')
        and c.relname = 'pilot_universal_stop_rules_one_current_per_ordinal'
        and i.indisunique
        and pg_get_indexdef(i.indexrelid) like '%(organization_id, ordinal)%'
        and pg_get_expr(i.indpred, i.indrelid) like '%superseded_at IS NULL%'
        and pg_get_expr(i.indpred, i.indrelid) like '%active%'
    ) as universal_one_current_per_ordinal_ready,
    exists (
      select 1
      from pg_index i
      join pg_class c on c.oid = i.indexrelid
      where i.indrelid = to_regclass('pilot.universal_stop_rules')
        and c.relname = 'pilot_universal_stop_rules_one_head_per_lineage'
        and i.indisunique
        and pg_get_expr(i.indpred, i.indrelid) = '(superseded_at IS NULL)'
    ) as universal_one_head_per_lineage_ready,
    to_regclass('pilot.reference_content_revisions') is not null as revisions_table_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_reference_content_revisions_pkey'
        and conrelid = to_regclass('pilot.reference_content_revisions')
        and contype = 'p'
        and pg_get_constraintdef(oid) = 'PRIMARY KEY (organization_id, dataset, item_key, version)'
    ) as revisions_pk_ready,
    exists (
      select 1 from pg_trigger t
      where t.tgrelid = to_regclass('pilot.reference_content_revisions')
        and t.tgname = 'pilot_reference_content_revisions_append_only'
        and not t.tgisinternal
        and t.tgenabled <> 'D'
        and t.tgfoid = to_regprocedure('pilot.reference_content_revisions_append_only()')
        and (t.tgtype & 1) <> 0
        and (t.tgtype & 2) <> 0
        and (t.tgtype & 8) <> 0
        and (t.tgtype & 16) <> 0
    ) as revisions_append_only_trigger_ready,
    coalesce(obj_description(to_regclass('pilot.drill_stop_rules'), 'pg_class'), '')
      not like '%five Universal Stop Rules%'
      and coalesce(obj_description(to_regclass('pilot.drill_stop_rules'), 'pg_class'), '')
        like '%pilot.universal_stop_rules%'
      as drill_stop_rules_comment_corrected
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    const failed = row
      ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key)
      : ['no readiness row'];
    throw new Error(`CONTENT_IMPORT_NOT_READY: ${failed.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_content_import_migration.sql',
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
  console.log(`Applied content import migration: ${migrationPath}`);
  console.log('PILOT CONTENT IMPORT MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT CONTENT IMPORT MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
