import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the assessment-catalog migration (lane CAT-a) inside one transaction,
// with the same target-verification discipline as every other pilot:apply-*
// script: the operator must state which host and database they believe they
// are pointing at, and a mismatch refuses before any DDL runs.

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

export const CATALOG_TABLES = [
  'pathway_gates',
  'pathway_gate_criteria',
  'scorecard_scales',
  'scorecard_score_caps',
  'scorecard_items',
  'scorecard_anchor_clip_specs',
  'behavior_kpi_lists',
  'behavior_kpis',
];

export const PROTOCOL_COLUMNS = [
  'protocol_group', 'status', 'sources', 'decision', 'field_labels', 'evidence', 'backbone_version',
];

// The foreign keys inside the catalog and to the pathway stages, by name and
// by the table each must point at.
const CATALOG_KEYS = [
  ['pilot_pathway_gates_stage_fkey', 'pathway_stages'],
  ['pilot_pathway_gate_criteria_gate_fkey', 'pathway_gates'],
  ['pilot_pathway_gate_criteria_ref_stage_fkey', 'pathway_stages'],
  ['pilot_pathway_gate_criteria_ref_gate_fkey', 'pathway_gates'],
  ['pilot_pathway_gate_criteria_ref_gate_match_fkey', 'pathway_gates'],
  ['pilot_scorecard_score_caps_scale_fkey', 'scorecard_scales'],
  ['pilot_scorecard_items_scale_fkey', 'scorecard_scales'],
  ['pilot_scorecard_anchor_clip_specs_item_fkey', 'scorecard_items'],
  ['pilot_behavior_kpis_list_fkey', 'behavior_kpi_lists'],
];

const CHECKS = [
  'pilot_pathway_gates_kind_check', 'pilot_pathway_gates_informs_only_check', 'pilot_pathway_gates_id_check',
  'pilot_pathway_gate_criteria_kind_check', 'pilot_pathway_gate_criteria_kind_shape_check',
  'pilot_pathway_gate_criteria_contexts_check', 'pilot_pathway_gate_criteria_id_check',
  'pilot_scorecard_items_id_check', 'pilot_scorecard_anchor_clip_specs_id_check',
  'pilot_scorecard_anchor_clip_specs_level_check', 'pilot_scorecard_anchor_clip_specs_context_check',
  'pilot_behavior_kpis_scoring_kind_check', 'pilot_behavior_kpis_anchors_check', 'pilot_behavior_kpis_id_check',
  'pilot_assessment_protocols_status_check', 'pilot_assessment_protocols_field_labels_check',
  'pilot_assessment_protocols_evidence_check',
];

const UNIQUES = [
  'pilot_pathway_gates_stage_kind_key', 'pilot_pathway_gates_id_stage_kind_key',
];

const tableList = CATALOG_TABLES.map((t) => `to_regclass('pilot.${t}')`).join(', ');

// Asserts the eight tables, each one's cascade from its organization, every
// catalog key (found by name AND by both tables, so a same-named constraint
// elsewhere cannot stand in; each NO ACTION, as the pathway catalog's), the
// gates' two unique keys, the vocabulary and shape checks, the eight no-delete
// triggers (each calling pilot.pathway_catalog_no_delete()), and that the seven protocol columns exist, are nullable
// and carry no default (so no existing protocol row was given a value).
export const READINESS_QUERY = `
  with c as (
    select conname, contype, confdeltype, conrelid, confrelid from pg_constraint
    where conrelid in (${tableList}, to_regclass('pilot.assessment_protocols'))
  )
  select
    (select count(*) from unnest(array[${tableList}]) t where t is not null) = ${CATALOG_TABLES.length} as tables_ready,
    (select count(*) from c where contype = 'f' and confdeltype = 'c'
       and confrelid = to_regclass('pilot.organizations')
       and conrelid in (${tableList})
    ) = ${CATALOG_TABLES.length} as organization_cascade_ready,
    (select count(*) from c join (values ${CATALOG_KEYS.map(([n, t]) => `('${n}', '${t}')`).join(', ')}) k(name, target)
       on c.conname = k.name and c.contype = 'f' and c.confrelid = to_regclass('pilot.' || k.target)
       and c.confdeltype = 'a' and c.conrelid in (${tableList})
    ) = ${CATALOG_KEYS.length} as catalog_keys_ready,
    (select count(*) from c where contype = 'u' and conname in (${UNIQUES.map((n) => `'${n}'`).join(', ')})
       and conrelid = to_regclass('pilot.pathway_gates')
    ) = ${UNIQUES.length} as gate_keys_ready,
    (select count(*) from c where contype = 'c' and conname in (${CHECKS.map((n) => `'${n}'`).join(', ')})
    ) = ${CHECKS.length} as checks_ready,
    (select count(*) from pg_trigger where not tgisinternal
       and tgname in (${CATALOG_TABLES.map((t) => `'pilot_${t}_no_delete'`).join(', ')})
       and tgrelid in (${tableList})
       and tgfoid = to_regprocedure('pilot.pathway_catalog_no_delete()')
    ) = ${CATALOG_TABLES.length} as no_delete_ready,
    (select count(*) from information_schema.columns
      where table_schema = 'pilot' and table_name = 'assessment_protocols'
        and column_name in (${PROTOCOL_COLUMNS.map((n) => `'${n}'`).join(', ')})
        and is_nullable = 'YES' and column_default is null
    ) = ${PROTOCOL_COLUMNS.length} as protocol_columns_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    const failed = row ? Object.entries(row).filter(([, value]) => value !== true).map(([key]) => key) : ['no row'];
    throw new Error(`ASSESSMENT_CATALOG_NOT_READY: ${failed.join(', ')}`);
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
    '../../../infra/azure/pilot_slice_postgres_assessment_catalog_migration.sql',
  );

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  try {
    await applyMigrationTransaction(client, sql);
    const { rows } = await client.query('select count(*)::int as n from pilot.assessment_protocols');
    console.log(`assessment_protocols rows (unchanged by this migration): ${rows[0].n}`);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied assessment catalog migration: ${migrationPath}`);
  console.log('PILOT ASSESSMENT CATALOG MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT ASSESSMENT CATALOG MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
