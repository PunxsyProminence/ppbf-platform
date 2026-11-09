import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the pathway-catalog migration (backbone crossover lane BB-1b) inside one transaction,
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

// Asserts the three catalog tables, each one's cascade from its organization,
// the stage foreign keys (both link ends, a default's stage, and
// content_stage_links' stage key), the vocabulary checks, the one-row-per-
// scope-and-key constraint and the three no-delete triggers, and that lane
// BB-1a's stage-key CHECK is gone, so an environment missing any piece cannot
// pass. Constraints are found by name AND by table, so a same-named
// constraint elsewhere cannot stand in. The content_stage_links key may be
// NOT VALID (existing rows kept, migration (4)); it must exist.
const READINESS_QUERY = `
  with c as (
    select conname, contype, confdeltype, conrelid, confrelid from pg_constraint
    where conrelid in (
      to_regclass('pilot.pathway_stages'),
      to_regclass('pilot.pathway_stage_links'),
      to_regclass('pilot.pathway_stage_defaults'),
      to_regclass('pilot.content_stage_links')
    )
  )
  select
    to_regclass('pilot.pathway_stages') is not null as stages_ready,
    to_regclass('pilot.pathway_stage_links') is not null as links_ready,
    to_regclass('pilot.pathway_stage_defaults') is not null as defaults_ready,
    (select count(*) from c where contype = 'f' and confdeltype = 'c'
       and confrelid = to_regclass('pilot.organizations')
       and conrelid in (to_regclass('pilot.pathway_stages'), to_regclass('pilot.pathway_stage_links'), to_regclass('pilot.pathway_stage_defaults'))
    ) = 3 as organization_cascade_ready,
    (select count(*) from c where contype = 'f' and confrelid = to_regclass('pilot.pathway_stages') and conname in (
       'pilot_pathway_stage_links_from_fkey', 'pilot_pathway_stage_links_to_fkey',
       'pilot_pathway_stage_defaults_stage_fkey', 'pilot_content_stage_links_stage_fkey')
    ) = 4 as stage_keys_reference_catalog_ready,
    not exists (
      select 1 from c where conname = 'pilot_content_stage_links_stage_check'
    ) as old_stage_check_gone,
    (select count(*) from c where contype = 'c' and conname in (
       'pilot_pathway_stages_segment_check', 'pilot_pathway_stages_contact_default_check',
       'pilot_pathway_stage_links_kind_check', 'pilot_pathway_stage_defaults_kind_check',
       'pilot_pathway_stage_defaults_status_check', 'pilot_pathway_stage_defaults_id_check')
    ) = 6 as vocabulary_checks_ready,
    exists (
      select 1 from c where contype = 'u' and conname = 'pilot_pathway_stage_defaults_scope_key'
        and conrelid = to_regclass('pilot.pathway_stage_defaults')
    ) as one_default_per_scope_ready,
    (select count(*) from pg_trigger where not tgisinternal and tgname in (
       'pilot_pathway_stages_no_delete', 'pilot_pathway_stage_links_no_delete', 'pilot_pathway_stage_defaults_no_delete')
       and tgrelid in (to_regclass('pilot.pathway_stages'), to_regclass('pilot.pathway_stage_links'), to_regclass('pilot.pathway_stage_defaults'))
    ) = 3 as no_delete_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('PATHWAY_CATALOG_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_pathway_catalog_migration.sql',
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
  console.log(`Applied pathway catalog migration: ${migrationPath}`);
  console.log('PILOT PATHWAY CATALOG MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT PATHWAY CATALOG MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
