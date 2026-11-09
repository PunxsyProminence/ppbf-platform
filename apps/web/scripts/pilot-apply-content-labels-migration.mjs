import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

// Applies the content-labels migration (backbone crossover lane BB-1a) inside one transaction,
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

// Asserts both tables, each one's cascade from its organization, the label
// shape checks, the one-current-link index (by shape,
// not name: CREATE INDEX IF NOT EXISTS skips a same-named index of any shape),
// and both guard triggers, so an environment missing any piece cannot pass.
// Not the stage_key check: lane BB-1b replaces it with a foreign key to the
// pathway stage catalog, and nothing may depend on it in the meantime.
const READINESS_QUERY = `
  with c as (
    select conname, confdeltype, conrelid from pg_constraint
    where conrelid in (to_regclass('pilot.content_record_labels'), to_regclass('pilot.content_stage_links'))
  ),
  i as (
    select ic.relname as indexname, x.indrelid,
           pg_get_expr(x.indpred, x.indrelid) as pred,
           (select array_agg(a.attname::text order by k.ord)
              from unnest(x.indkey::int2[]) with ordinality as k(attnum, ord)
              join pg_attribute a on a.attrelid = x.indrelid and a.attnum = k.attnum) as cols
    from pg_index x
    join pg_class ic on ic.oid = x.indexrelid
    where x.indisunique and x.indisvalid
  )
  select
    to_regclass('pilot.content_record_labels') is not null as labels_ready,
    to_regclass('pilot.content_stage_links') is not null as links_ready,
    exists (
      select 1 from c where confdeltype = 'c' and conrelid = to_regclass('pilot.content_record_labels')
    ) as labels_cascade_ready,
    exists (
      select 1 from c where confdeltype = 'c' and conrelid = to_regclass('pilot.content_stage_links')
    ) as links_cascade_ready,
    exists (
      select 1 from c where conname = 'pilot_content_record_labels_pkey' and conrelid = to_regclass('pilot.content_record_labels')
    ) as one_label_row_per_version_ready,
    exists (
      select 1 from c where conname = 'pilot_content_record_labels_field_labels_check' and conrelid = to_regclass('pilot.content_record_labels')
    ) as field_labels_shape_ready,
    exists (
      select 1 from c where conname = 'pilot_content_record_labels_evidence_check' and conrelid = to_regclass('pilot.content_record_labels')
    ) as evidence_shape_ready,
    exists (
      select 1 from i where indexname = 'idx_content_stage_links_current'
        and indrelid = to_regclass('pilot.content_stage_links')
        and cols = array['organization_id', 'target_kind', 'target_lineage_id', 'stage_key']
        and pred = '(superseded_at IS NULL)'
    ) as one_current_link_ready,
    exists (
      select 1 from pg_trigger where tgname = 'pilot_content_record_labels_append_only'
        and tgrelid = to_regclass('pilot.content_record_labels') and not tgisinternal
    ) as labels_append_only_ready,
    exists (
      select 1 from pg_trigger where tgname = 'pilot_content_stage_links_guard'
        and tgrelid = to_regclass('pilot.content_stage_links') and not tgisinternal
    ) as links_guard_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('CONTENT_LABELS_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_content_labels_migration.sql',
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
  console.log(`Applied content labels migration: ${migrationPath}`);
  console.log('PILOT CONTENT LABELS MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT CONTENT LABELS MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
