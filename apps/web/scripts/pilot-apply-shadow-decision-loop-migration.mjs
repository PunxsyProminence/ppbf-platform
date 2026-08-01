// Applies the SHADOW decision loop migration.
//
// Unreachable until 2026-08-01: the SQL existed and nothing could dispatch it.
// Its six tables back shadowRecommendations, shadowDecisions, shadowNearMisses
// and shadowDecisionOutcomes, which together serve nine API routes -- a rebuilt
// environment would have returned 500s from all of them.
//
// This migration's SQL opens and closes its own transaction, so this runner
// deliberately does NOT wrap it in one. Issuing BEGIN around a self-transacting
// migration nests the transaction: the migration's own COMMIT ends it, a
// trailing COMMIT here warns that none is in progress, and -- the part that
// matters -- a ROLLBACK after a failed readiness check would silently do
// nothing, because the work is already committed. The readiness assertion below
// is therefore a post-commit verification that fails the run loudly, not a gate
// that can undo it.
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

// shadow_medical_administrative_status is named first and checked by name rather
// than folded into a count: it is the administrative (never clinical) medical
// hold this loop consults before a recommendation may stand, and a database
// missing only that table would otherwise pass a five-of-six check while the one
// gate with a safety argument behind it was absent.
const READINESS_QUERY = `
  select
    to_regclass('pilot.shadow_medical_administrative_status') is not null as medical_status_ready,
    to_regclass('pilot.shadow_recommendations') is not null as recommendations_ready,
    to_regclass('pilot.shadow_decisions') is not null as decisions_ready,
    to_regclass('pilot.shadow_near_misses') is not null as near_misses_ready,
    to_regclass('pilot.shadow_decision_outcomes') is not null as decision_outcomes_ready,
    to_regclass('pilot.shadow_audit_entries') is not null as audit_entries_ready,
    (
      select count(*) = 6
      from pg_indexes
      where schemaname = 'pilot'
        and indexname in (
          'idx_shadow_medical_status_athlete',
          'idx_shadow_recommendations_athlete_status',
          'idx_shadow_decisions_athlete',
          'idx_shadow_near_misses_athlete',
          'idx_shadow_decision_outcomes_decision',
          'idx_shadow_audit_entries_entity'
        )
    ) as decision_loop_indexes_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('SHADOW_DECISION_LOOP_NOT_READY');
  }
}

export async function applyMigration(client, sql) {
  await client.query(sql);
  const readiness = await client.query(READINESS_QUERY);
  assertReadiness(readiness.rows[0]);
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
    '../../../infra/azure/pilot_slice_postgres_shadow_decision_loop_migration.sql',
  );

  const sql = await fs.readFile(migrationPath, 'utf8');

  const client = new Client({
    connectionString,
    ssl: resolveSslConfig(),
  });

  await client.connect();
  try {
    await applyMigration(client, sql);
  } finally {
    await client.end();
  }

  console.log(`target_hostname: ${target.hostname}`);
  console.log(`target_database: ${target.database}`);
  console.log(`Applied SHADOW decision loop migration: ${migrationPath}`);
  console.log('PILOT SHADOW DECISION LOOP MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SHADOW DECISION LOOP MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
