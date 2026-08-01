// Applies the SHADOW evidence migration.
//
// Unreachable until 2026-08-01: the SQL existed and nothing could dispatch it.
// The tables it creates are written on the live chat path --
// shadowConversations.ts inserts into shadow_evidence_claims and
// shadow_message_citations for every stored assistant message -- so a rebuilt
// environment would have taken SHADOW chat persistence down with it.
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

// The four UNIQUE indexes are checked as carefully as the tables, because they
// are the half of this migration that acts on tables which already exist. They
// stop the same library source, document or chunk being ingested twice for one
// tenant, and a table-only check would pass on a database where the tables
// landed and the identity constraints did not -- the state that silently admits
// duplicate evidence into retrieval.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// column is evaluated when a table is absent, reporting an unmigrated database
// as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.shadow_evidence_bundles') is not null as bundles_ready,
    to_regclass('pilot.shadow_evidence_items') is not null as items_ready,
    to_regclass('pilot.shadow_evidence_claims') is not null as claims_ready,
    to_regclass('pilot.shadow_message_citations') is not null as citations_ready,
    (
      select count(*) = 4
      from pg_indexes
      where schemaname = 'pilot'
        and indexname in (
          'idx_shadow_library_sources_tenant_identity',
          'idx_shadow_library_documents_tenant_identity',
          'idx_shadow_library_chunks_tenant_identity',
          'idx_shadow_chat_messages_owner_identity'
        )
    ) as tenant_identity_indexes_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('SHADOW_EVIDENCE_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_shadow_evidence_migration.sql',
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
  console.log(`Applied SHADOW evidence migration: ${migrationPath}`);
  console.log('PILOT SHADOW EVIDENCE MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT SHADOW EVIDENCE MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
