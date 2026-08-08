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

function resolveSslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') {
    return false;
  }
  return { rejectUnauthorized: true };
}

// Readiness asserts the WIDENED vocabularies are actually in place, not merely
// that a constraint by that name exists. A migration that dropped the old
// CHECK and failed to add the new one would leave the column unconstrained --
// strictly worse than the narrow constraint it replaced -- and a name-only
// check would call that success.
const READINESS_QUERY = `
  select
    to_regclass('pilot.drill_scale_levels') is not null as scale_levels_table_ready,
    to_regclass('pilot.drill_stop_rules') is not null as stop_rules_table_ready,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_scale_authoring_state_check'
        and conrelid = to_regclass('pilot.drill_scale_levels')
        and pg_get_constraintdef(oid) like '%literature_grounded_draft%'
        and pg_get_constraintdef(oid) like '%authored%'
        and pg_get_constraintdef(oid) like '%scaffold_needs_coach_review%'
    ) as authoring_state_widened,
    exists (
      select 1 from pg_constraint
      where conname = 'pilot_drill_stop_rule_kind_check'
        and conrelid = to_regclass('pilot.drill_stop_rules')
        and pg_get_constraintdef(oid) like '%warmup_decay%'
        and pg_get_constraintdef(oid) like '%technique_degradation%'
        and pg_get_constraintdef(oid) like '%coach_judgment%'
    ) as rule_kind_widened,
    -- Exactly one CHECK per widened column: the loop that drops the old ones
    -- leaving a duplicate behind would re-impose the narrow vocabulary.
    (
      select count(*) from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      where nsp.nspname = 'pilot' and rel.relname = 'drill_scale_levels'
        and con.contype = 'c' and pg_get_constraintdef(con.oid) ilike '%authoring_state%'
    ) = 1 as authoring_state_single_check,
    (
      select count(*) from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace nsp on nsp.oid = rel.relnamespace
      where nsp.nspname = 'pilot' and rel.relname = 'drill_stop_rules'
        and con.contype = 'c' and pg_get_constraintdef(con.oid) ilike '%rule_kind%'
    ) = 1 as rule_kind_single_check
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('DRILL_VOCAB_WIDENING_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_drill_vocabulary_widening_migration.sql',
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
  console.log(`Applied drill vocabulary widening migration: ${migrationPath}`);
  console.log('PILOT DRILL VOCABULARY WIDENING MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT DRILL VOCABULARY WIDENING MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
