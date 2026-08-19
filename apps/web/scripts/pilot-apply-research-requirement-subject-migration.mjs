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

// Asserts the properties the migration exists for, not merely that a column
// by that name appeared.
//
// `column_ready` requires nullable text, matching pilot.shadow_library_documents.
// subject_id exactly: this is a mirror of that table's pattern, deliberately
// without a foreign key (unlike shadow_jobs.subject_id / shadow_evidence_
// bundles.subject_id, which both do reference pilot.athletes) -- a research
// requirement about an athlete who has since left the roster should stay
// legible, not be blocked or cascaded away.
//
// `old_columns_untouched_ready` confirms the idempotency key this table
// already relies on -- unique (organization_id, source_event_name,
// source_entity_type, source_entity_id), read from source_entity_id staying
// NOT NULL -- was left alone: this migration adds a column, it does not
// loosen or drop one, and createShadowResearchRequirement's ON CONFLICT
// target must keep resolving to the same four columns.
//
// to_regclass() rather than the ::regclass cast: the cast raises before any
// column is evaluated when the table is absent, which would report an
// unmigrated database as a SQL error instead of as unreadiness.
const READINESS_QUERY = `
  select
    to_regclass('pilot.shadow_research_requirements') is not null as table_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_research_requirements'
        and column_name = 'subject_id'
        and data_type = 'text'
        and is_nullable = 'YES'
    ) as column_ready,
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'pilot'
        and table_name = 'shadow_research_requirements'
        and column_name = 'source_entity_id'
        and is_nullable = 'NO'
    ) as old_columns_untouched_ready,
    -- The clauses above report on the COLUMN, and the base schema
    -- (pilot_slice_postgres.sql) now declares subject_id directly. So on any
    -- database built from the base schema they are satisfied whether or not
    -- this migration ever ran, and the attestation proved nothing. What this
    -- migration actually contributes beyond the base schema is the BACKFILL,
    -- so that is what is asserted here: the exact predicate the migration's
    -- UPDATE selects on, negated. If a single row is still left with a null
    -- subject_id while one of the three legacy fields names an athlete in
    -- that row's own organization, the backfill did not run and the runner
    -- must refuse.
    --
    -- subject_id is read through to_jsonb(rr) rather than as rr.subject_id on
    -- purpose: a missing column would make rr.subject_id a parse error that
    -- RAISES before assertReadiness() is ever reached, so the operator would
    -- get a raw Postgres error instead of the sentinel that column_ready
    -- above exists to report. Through to_jsonb the query parses either way
    -- and a missing column simply reads as null, which fails this clause.
    not exists (
      select 1
      from pilot.shadow_research_requirements rr
      left join pilot.athletes matched_meta
        on matched_meta.organization_id = rr.organization_id
       and matched_meta.athlete_id = nullif(rr.metadata->>'subject_id', '')
      left join pilot.athletes matched_label
        on matched_label.organization_id = rr.organization_id
       and matched_label.athlete_id = nullif(rr.evidence_label, '')
      left join pilot.athletes matched_entity
        on matched_entity.organization_id = rr.organization_id
       and matched_entity.athlete_id = rr.source_entity_id
      where to_jsonb(rr) ->> 'subject_id' is null
        and coalesce(
          matched_meta.athlete_id,
          matched_label.athlete_id,
          matched_entity.athlete_id
        ) is not null
    ) as subject_backfill_ready
`;

function assertReadiness(row) {
  if (!row || Object.values(row).some((value) => value !== true)) {
    throw new Error('RESEARCH_REQUIREMENT_SUBJECT_NOT_READY');
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
    '../../../infra/azure/pilot_slice_postgres_research_requirement_subject_migration.sql',
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
  console.log(`Applied research requirement subject migration: ${migrationPath}`);
  console.log('PILOT RESEARCH REQUIREMENT SUBJECT MIGRATION PASS');
}

const isMainModule = process.argv[1] === fileURLToPath(import.meta.url);
if (isMainModule) {
  try {
    await run();
  } catch (error) {
    console.error('PILOT RESEARCH REQUIREMENT SUBJECT MIGRATION FAIL');
    console.error(String(error));
    process.exit(1);
  }
}
