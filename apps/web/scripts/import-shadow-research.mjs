import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parse } from 'csv-parse/sync';
import { Client } from 'pg';

import { assertDeclaredWriteTargetFromEnv } from './lib/postgres-write-target.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DEFAULT_SEED_DIR = path.resolve(
  __dirname,
  '../seed-data/shadow-research/2026-08-07',
);

export const EXPECTED_COUNTS = Object.freeze({
  sources: 1214,
  documents: 14,
  chunks: 1193,
  capabilityMap: 30,
  requirements: 229,
});

const FILES = Object.freeze({
  sources: 'seed_shadow_library_sources.csv',
  documents: 'seed_shadow_library_documents.csv',
  chunks: 'seed_shadow_library_chunks.csv',
  capabilityMap: 'seed_shadow_library_capability_map.csv',
  requirements: 'seed_shadow_research_requirements.csv',
});

const PRIVILEGED_ROLES = new Set(['platform_owner', 'organization_admin', 'admin']);

function fail(message) {
  throw new Error(message);
}

function required(value, token) {
  const normalized = value?.trim() || '';
  if (!normalized) fail(token);
  return normalized;
}

function nullable(value) {
  const normalized = value?.trim() || '';
  return normalized || null;
}

function integer(value, field) {
  if (!/^-?\d+$/.test(String(value))) fail(`INVALID_INTEGER:${field}:${value}`);
  return Number(value);
}

function metadata(value, fileName, rowNumber) {
  try {
    const parsed = JSON.parse(value || '{}');
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error();
    return parsed;
  } catch {
    fail(`INVALID_METADATA_JSON:${fileName}:${rowNumber}`);
  }
}

export function parsePostgresTextArray(value) {
  const text = String(value || '').trim();
  if (text === '{}') return [];
  if (!text.startsWith('{') || !text.endsWith('}')) {
    fail(`INVALID_POSTGRES_TEXT_ARRAY:${text}`);
  }

  const body = text.slice(1, -1);
  const values = [];
  let current = '';
  let quoted = false;
  let escaped = false;
  for (const character of body) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  if (quoted || escaped) fail(`INVALID_POSTGRES_TEXT_ARRAY:${text}`);
  values.push(current);
  return values.map((entry) => entry.trim()).filter(Boolean);
}

function replacePlaceholders(record, organizationId, accountId, role) {
  const replaced = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === '{{PPBF_ORG_ID}}') replaced[key] = organizationId;
    else if (value === '{{SEED_ACCOUNT_ID}}') replaced[key] = accountId;
    else if (key === 'created_by_role') replaced[key] = role;
    else replaced[key] = value;
  }
  for (const value of Object.values(replaced)) {
    if (typeof value === 'string' && value.includes('{{')) fail('UNRESOLVED_SEED_PLACEHOLDER');
  }
  return replaced;
}

async function readCsv(seedDir, fileName) {
  const source = await fs.readFile(path.join(seedDir, fileName), 'utf8');
  return parse(source, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
    relax_column_count: false,
  });
}

function assertCount(name, rows) {
  const expected = EXPECTED_COUNTS[name];
  if (rows.length !== expected) fail(`ROW_COUNT_MISMATCH:${name}:expected=${expected}:actual=${rows.length}`);
}

function assertUnique(rows, key, label) {
  const seen = new Set();
  for (const row of rows) {
    const value = typeof key === 'function' ? key(row) : row[key];
    if (seen.has(value)) fail(`DUPLICATE_SEED_KEY:${label}:${value}`);
    seen.add(value);
  }
}

export async function loadSeedPackage({
  seedDir = DEFAULT_SEED_DIR,
  organizationId,
  accountId,
  createdByRole = 'platform_owner',
}) {
  organizationId = required(organizationId, 'MISSING_PPBF_ORG_ID');
  accountId = required(accountId, 'MISSING_SEED_ACCOUNT_ID');

  const raw = {};
  for (const [name, fileName] of Object.entries(FILES)) {
    raw[name] = (await readCsv(seedDir, fileName)).map((row) =>
      replacePlaceholders(row, organizationId, accountId, createdByRole));
    assertCount(name, raw[name]);
  }

  const sources = raw.sources.map((row, index) => ({
    source_id: required(row.source_id, `MISSING_SOURCE_ID:${index + 2}`),
    organization_id: row.organization_id,
    title: required(row.title, `MISSING_SOURCE_TITLE:${index + 2}`),
    publisher: nullable(row.publisher),
    source_type: required(row.source_type, `MISSING_SOURCE_TYPE:${index + 2}`),
    authority_tier: integer(row.authority_tier, 'authority_tier'),
    url: nullable(row.url),
    publication_date: nullable(row.publication_date),
    status: required(row.status, `MISSING_SOURCE_STATUS:${index + 2}`),
    // The review gate. Not a column addition for its own sake -- these are
    // the columns pilot_slice_postgres_shadow_evidence_migration.sql adds
    // to gate retrieval, and a seed that omitted them and let the column
    // default carry the posture left nothing in the version-controlled
    // file recording that this corpus is unreviewed. Refused below to
    // anything but the seed-only values -- see assertSeedOnlyReviewState.
    approval_state: required(row.approval_state, `MISSING_APPROVAL_STATE:${index + 2}`),
    verification_state: required(row.verification_state, `MISSING_VERIFICATION_STATE:${index + 2}`),
    created_by_account_id: row.created_by_account_id,
    created_by_role: row.created_by_role,
    metadata: metadata(row.metadata, FILES.sources, index + 2),
  }));

  const documents = raw.documents.map((row, index) => ({
    document_id: required(row.document_id, `MISSING_DOCUMENT_ID:${index + 2}`),
    source_id: required(row.source_id, `MISSING_DOCUMENT_SOURCE_ID:${index + 2}`),
    organization_id: row.organization_id,
    subject_id: nullable(row.subject_id),
    document_name: required(row.document_name, `MISSING_DOCUMENT_NAME:${index + 2}`),
    blob_path: nullable(row.blob_path),
    content_sha256: nullable(row.content_sha256),
    // Never 'indexed' -- see assertSeedOnlyReviewState. The indexing
    // pipeline owns that transition; this importer does not claim work it
    // has not done.
    ingest_state: required(row.ingest_state, `MISSING_INGEST_STATE:${index + 2}`),
    approval_state: required(row.approval_state, `MISSING_APPROVAL_STATE:${index + 2}`),
    verification_state: required(row.verification_state, `MISSING_VERIFICATION_STATE:${index + 2}`),
    extraction_error: nullable(row.extraction_error),
    created_by_account_id: row.created_by_account_id,
    created_by_role: row.created_by_role,
    metadata: metadata(row.metadata, FILES.documents, index + 2),
  }));

  // Defense in depth, not trust in the CSV: even though the committed
  // files carry the right values, refuse outright if any row claims a
  // trusted state. This is the ONLY route by which the seed path could
  // ever mark evidence approved/verified/indexed, and it is closed here
  // rather than relied upon by convention. reviewShadowLibrarySource /
  // reviewShadowLibraryDocument (via requireEvidenceReviewer in
  // shadowLibrary.ts) remain the only real route to those states.
  for (const [index, row] of sources.entries()) {
    if (row.approval_state !== 'pending_review' || row.verification_state !== 'unverified') {
      fail(`SEED_ROW_CLAIMS_TRUSTED_STATE:sources:${index + 2}`);
    }
  }
  for (const [index, row] of documents.entries()) {
    if (row.approval_state !== 'pending_review' || row.verification_state !== 'unverified') {
      fail(`SEED_ROW_CLAIMS_TRUSTED_STATE:documents:${index + 2}`);
    }
    if (row.ingest_state === 'indexed') {
      fail(`SEED_ROW_CLAIMS_INDEXED:documents:${index + 2}`);
    }
  }

  const chunks = raw.chunks.map((row, index) => ({
    chunk_id: required(row.chunk_id, `MISSING_CHUNK_ID:${index + 2}`),
    document_id: required(row.document_id, `MISSING_CHUNK_DOCUMENT_ID:${index + 2}`),
    source_id: required(row.source_id, `MISSING_CHUNK_SOURCE_ID:${index + 2}`),
    organization_id: row.organization_id,
    subject_id: nullable(row.subject_id),
    ordinal: integer(row.ordinal, 'ordinal'),
    text_content: required(row.text_content, `MISSING_CHUNK_TEXT:${index + 2}`),
    created_by_account_id: row.created_by_account_id,
    created_by_role: row.created_by_role,
    metadata: metadata(row.metadata, FILES.chunks, index + 2),
  }));

  const capabilityMap = raw.capabilityMap.map((row, index) => ({
    capability_map_id: required(row.capability_map_id, `MISSING_CAPABILITY_MAP_ID:${index + 2}`),
    organization_id: row.organization_id,
    capability_key: required(row.capability_key, `MISSING_CAPABILITY_KEY:${index + 2}`),
    required_source_types: parsePostgresTextArray(row.required_source_types),
    minimum_authority_tier: integer(row.minimum_authority_tier, 'minimum_authority_tier'),
    minimum_source_count: integer(row.minimum_source_count, 'minimum_source_count'),
    coverage_state: required(row.coverage_state, `MISSING_COVERAGE_STATE:${index + 2}`),
  }));

  const requirements = raw.requirements.map((row, index) => ({
    organization_id: row.organization_id,
    source_event_name: required(row.source_event_name, `MISSING_SOURCE_EVENT:${index + 2}`),
    source_entity_type: required(row.source_entity_type, `MISSING_SOURCE_ENTITY_TYPE:${index + 2}`),
    source_entity_id: required(row.source_entity_id, `MISSING_SOURCE_ENTITY_ID:${index + 2}`),
    research_requirement: required(row.research_requirement, `MISSING_REQUIREMENT:${index + 2}`),
    knowledge_gap: required(row.knowledge_gap, `MISSING_KNOWLEDGE_GAP:${index + 2}`),
    evidence_label: nullable(row.evidence_label),
    source_status: required(row.source_status, `MISSING_SOURCE_STATUS:${index + 2}`),
    source_confidence_tier: required(row.source_confidence_tier, `MISSING_CONFIDENCE_TIER:${index + 2}`),
    source_verification_state: required(row.source_verification_state, `MISSING_VERIFICATION_STATE:${index + 2}`),
    status: required(row.status, `MISSING_REQUIREMENT_STATUS:${index + 2}`),
    created_by_account_id: row.created_by_account_id,
    created_by_role: row.created_by_role,
    metadata: metadata(row.metadata, FILES.requirements, index + 2),
  }));

  for (const [name, rows] of Object.entries({ sources, documents, chunks, capabilityMap, requirements })) {
    if (rows.some((row) => row.organization_id !== organizationId)) fail(`CROSS_TENANT_SEED_ROW:${name}`);
  }

  assertUnique(sources, 'source_id', 'source_id');
  assertUnique(documents, 'document_id', 'document_id');
  assertUnique(chunks, 'chunk_id', 'chunk_id');
  assertUnique(chunks, (row) => `${row.document_id}:${row.ordinal}`, 'document_ordinal');
  assertUnique(capabilityMap, 'capability_map_id', 'capability_map_id');
  assertUnique(capabilityMap, 'capability_key', 'capability_key');
  assertUnique(
    requirements,
    (row) => `${row.source_event_name}:${row.source_entity_type}:${row.source_entity_id}`,
    'research_requirement_natural_key',
  );

  const sourceIds = new Set(sources.map((row) => row.source_id));
  const documentsById = new Map(documents.map((row) => [row.document_id, row]));
  for (const document of documents) {
    if (!sourceIds.has(document.source_id)) fail(`DOCUMENT_SOURCE_NOT_IN_PACKAGE:${document.document_id}`);
  }
  for (const chunk of chunks) {
    const document = documentsById.get(chunk.document_id);
    if (!document) fail(`CHUNK_DOCUMENT_NOT_IN_PACKAGE:${chunk.chunk_id}`);
    if (!sourceIds.has(chunk.source_id)) fail(`CHUNK_SOURCE_NOT_IN_PACKAGE:${chunk.chunk_id}`);
  }

  return { sources, documents, chunks, capabilityMap, requirements };
}

async function assertActor(client, organizationId, accountId) {
  const organization = await client.query(
    'select organization_id from pilot.organizations where organization_id = $1',
    [organizationId],
  );
  if (organization.rowCount !== 1) fail('PPBF_ORGANIZATION_NOT_FOUND');

  const account = await client.query(
    `select account_id, organization_id, role, is_platform_owner, active_flag
     from pilot.accounts where account_id = $1`,
    [accountId],
  );
  const actor = account.rows[0];
  if (!actor) fail('SEED_ACCOUNT_NOT_FOUND');
  if (!actor.active_flag) fail('SEED_ACCOUNT_INACTIVE');
  if (!PRIVILEGED_ROLES.has(actor.role)) fail('SEED_ACCOUNT_NOT_PRIVILEGED');
  if (actor.organization_id !== organizationId && !actor.is_platform_owner) fail('SEED_ACCOUNT_TENANT_MISMATCH');
  return actor;
}

async function assertNoCrossTenantIds(client, table, idColumn, ids, organizationId) {
  const result = await client.query(
    `select ${idColumn} as id from pilot.${table}
     where ${idColumn} = any($1::text[]) and organization_id <> $2 limit 1`,
    [ids, organizationId],
  );
  if (result.rowCount) fail(`CROSS_TENANT_ID_COLLISION:${table}:${result.rows[0].id}`);
}

export async function assertReviewGateColumnsPresent(client) {
  const result = await client.query(
    `select
       exists (select 1 from information_schema.columns
               where table_schema = 'pilot' and table_name = 'shadow_library_sources'
                 and column_name in ('approval_state', 'verification_state')
               having count(*) = 2) as sources_ready,
       exists (select 1 from information_schema.columns
               where table_schema = 'pilot' and table_name = 'shadow_library_documents'
                 and column_name in ('approval_state', 'verification_state')
               having count(*) = 2) as documents_ready`,
  );
  const row = result.rows[0];
  if (!row?.sources_ready || !row?.documents_ready) {
    fail(
      'SHADOW_EVIDENCE_MIGRATION_NOT_APPLIED: approval_state/verification_state are missing from '
      + 'pilot.shadow_library_sources or pilot.shadow_library_documents -- apply '
      + 'pilot_slice_postgres_shadow_evidence_migration.sql before importing',
    );
  }
}

async function upsertSources(client, rows) {
  await client.query(
    `insert into pilot.shadow_library_sources
       (source_id, organization_id, title, publisher, source_type, authority_tier, url,
        publication_date, status, approval_state, verification_state,
        created_by_account_id, created_by_role, metadata)
     select source_id, organization_id, title, publisher, source_type, authority_tier, url,
            nullif(publication_date, '')::date, status, approval_state, verification_state,
            created_by_account_id, created_by_role, metadata
     from jsonb_to_recordset($1::jsonb) as x(
       source_id text, organization_id text, title text, publisher text, source_type text,
       authority_tier smallint, url text, publication_date text, status text,
       approval_state text, verification_state text,
       created_by_account_id text, created_by_role text, metadata jsonb
     )
     on conflict (source_id) do update set
       title = excluded.title, publisher = excluded.publisher, source_type = excluded.source_type,
       authority_tier = excluded.authority_tier, url = excluded.url,
       publication_date = excluded.publication_date, status = excluded.status,
       approval_state = excluded.approval_state, verification_state = excluded.verification_state,
       created_by_account_id = excluded.created_by_account_id,
       created_by_role = excluded.created_by_role, metadata = excluded.metadata, updated_at = now()`,
    [JSON.stringify(rows)],
  );
}

async function upsertDocuments(client, rows) {
  await client.query(
    `insert into pilot.shadow_library_documents
       (document_id, source_id, organization_id, subject_id, document_name, blob_path,
        content_sha256, ingest_state, approval_state, verification_state, extraction_error,
        created_by_account_id, created_by_role, metadata)
     select document_id, source_id, organization_id, subject_id, document_name, blob_path,
            content_sha256, ingest_state, approval_state, verification_state, extraction_error,
            created_by_account_id, created_by_role, metadata
     from jsonb_to_recordset($1::jsonb) as x(
       document_id text, source_id text, organization_id text, subject_id text, document_name text,
       blob_path text, content_sha256 text, ingest_state text, approval_state text,
       verification_state text, extraction_error text,
       created_by_account_id text, created_by_role text, metadata jsonb
     )
     on conflict (document_id) do update set
       source_id = excluded.source_id, subject_id = excluded.subject_id,
       document_name = excluded.document_name, blob_path = excluded.blob_path,
       content_sha256 = excluded.content_sha256, ingest_state = excluded.ingest_state,
       approval_state = excluded.approval_state, verification_state = excluded.verification_state,
       extraction_error = excluded.extraction_error,
       created_by_account_id = excluded.created_by_account_id,
       created_by_role = excluded.created_by_role, metadata = excluded.metadata, updated_at = now()`,
    [JSON.stringify(rows)],
  );
}

async function upsertChunks(client, rows) {
  await client.query(
    `insert into pilot.shadow_library_chunks
       (chunk_id, document_id, source_id, organization_id, subject_id, ordinal, text_content,
        created_by_account_id, created_by_role, metadata)
     select chunk_id, document_id, source_id, organization_id, subject_id, ordinal, text_content,
            created_by_account_id, created_by_role, metadata
     from jsonb_to_recordset($1::jsonb) as x(
       chunk_id text, document_id text, source_id text, organization_id text, subject_id text,
       ordinal int, text_content text, created_by_account_id text, created_by_role text, metadata jsonb
     )
     on conflict (chunk_id) do update set
       document_id = excluded.document_id, source_id = excluded.source_id,
       subject_id = excluded.subject_id, ordinal = excluded.ordinal,
       text_content = excluded.text_content, created_by_account_id = excluded.created_by_account_id,
       created_by_role = excluded.created_by_role, metadata = excluded.metadata, updated_at = now()`,
    [JSON.stringify(rows)],
  );
}

async function upsertCapabilityMap(client, rows) {
  await client.query(
    `insert into pilot.shadow_library_capability_map
       (capability_map_id, organization_id, capability_key, required_source_types,
        minimum_authority_tier, minimum_source_count, coverage_state, last_evaluated_at)
     select capability_map_id, organization_id, capability_key, required_source_types,
            minimum_authority_tier, minimum_source_count, coverage_state, now()
     from jsonb_to_recordset($1::jsonb) as x(
       capability_map_id text, organization_id text, capability_key text,
       required_source_types text[], minimum_authority_tier smallint,
       minimum_source_count smallint, coverage_state text
     )
     on conflict (capability_map_id) do update set
       capability_key = excluded.capability_key,
       required_source_types = excluded.required_source_types,
       minimum_authority_tier = excluded.minimum_authority_tier,
       minimum_source_count = excluded.minimum_source_count,
       coverage_state = excluded.coverage_state, last_evaluated_at = now(), updated_at = now()`,
    [JSON.stringify(rows)],
  );
}

async function upsertRequirements(client, rows) {
  await client.query(
    `insert into pilot.shadow_research_requirements
       (organization_id, source_event_name, source_entity_type, source_entity_id,
        research_requirement, knowledge_gap, evidence_label, source_status,
        source_confidence_tier, source_verification_state, status,
        created_by_account_id, created_by_role, metadata)
     select organization_id, source_event_name, source_entity_type, source_entity_id,
            research_requirement, knowledge_gap, evidence_label, source_status,
            source_confidence_tier, source_verification_state, status,
            created_by_account_id, created_by_role, metadata
     from jsonb_to_recordset($1::jsonb) as x(
       organization_id text, source_event_name text, source_entity_type text, source_entity_id text,
       research_requirement text, knowledge_gap text, evidence_label text, source_status text,
       source_confidence_tier text, source_verification_state text, status text,
       created_by_account_id text, created_by_role text, metadata jsonb
     )
     on conflict (organization_id, source_event_name, source_entity_type, source_entity_id)
     do update set
       research_requirement = excluded.research_requirement,
       knowledge_gap = excluded.knowledge_gap, evidence_label = excluded.evidence_label,
       source_status = excluded.source_status,
       source_confidence_tier = excluded.source_confidence_tier,
       source_verification_state = excluded.source_verification_state,
       status = excluded.status, created_by_account_id = excluded.created_by_account_id,
       created_by_role = excluded.created_by_role, metadata = excluded.metadata`,
    [JSON.stringify(rows)],
  );
}

async function verifyCount(client, table, idColumn, ids, organizationId, expected) {
  const result = await client.query(
    `select count(*)::int as count from pilot.${table}
     where organization_id = $1 and ${idColumn} = any($2::text[])`,
    [organizationId, ids],
  );
  if (result.rows[0]?.count !== expected) {
    fail(`POST_IMPORT_COUNT_MISMATCH:${table}:expected=${expected}:actual=${result.rows[0]?.count}`);
  }
}

async function verifyRequirements(client, rows, organizationId) {
  const result = await client.query(
    `select count(*)::int as count
     from pilot.shadow_research_requirements r
     join jsonb_to_recordset($2::jsonb) as x(
       source_event_name text, source_entity_type text, source_entity_id text
     ) on x.source_event_name = r.source_event_name
       and x.source_entity_type = r.source_entity_type
       and x.source_entity_id = r.source_entity_id
     where r.organization_id = $1`,
    [organizationId, JSON.stringify(rows)],
  );
  if (result.rows[0]?.count !== rows.length) {
    fail(`POST_IMPORT_COUNT_MISMATCH:shadow_research_requirements:expected=${rows.length}:actual=${result.rows[0]?.count}`);
  }
}

export async function importSeedPackage(client, seed, organizationId) {
  await client.query('begin');
  try {
    await client.query("set local lock_timeout = '10s'");
    await client.query("set local statement_timeout = '5min'");

    await assertReviewGateColumnsPresent(client);

    await assertNoCrossTenantIds(client, 'shadow_library_sources', 'source_id', seed.sources.map((r) => r.source_id), organizationId);
    await assertNoCrossTenantIds(client, 'shadow_library_documents', 'document_id', seed.documents.map((r) => r.document_id), organizationId);
    await assertNoCrossTenantIds(client, 'shadow_library_chunks', 'chunk_id', seed.chunks.map((r) => r.chunk_id), organizationId);
    await assertNoCrossTenantIds(client, 'shadow_library_capability_map', 'capability_map_id', seed.capabilityMap.map((r) => r.capability_map_id), organizationId);

    await upsertSources(client, seed.sources);
    await upsertDocuments(client, seed.documents);
    await upsertChunks(client, seed.chunks);
    await upsertCapabilityMap(client, seed.capabilityMap);
    await upsertRequirements(client, seed.requirements);

    await verifyCount(client, 'shadow_library_sources', 'source_id', seed.sources.map((r) => r.source_id), organizationId, seed.sources.length);
    await verifyCount(client, 'shadow_library_documents', 'document_id', seed.documents.map((r) => r.document_id), organizationId, seed.documents.length);
    await verifyCount(client, 'shadow_library_chunks', 'chunk_id', seed.chunks.map((r) => r.chunk_id), organizationId, seed.chunks.length);
    await verifyCount(client, 'shadow_library_capability_map', 'capability_map_id', seed.capabilityMap.map((r) => r.capability_map_id), organizationId, seed.capabilityMap.length);
    await verifyRequirements(client, seed.requirements, organizationId);

    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

function sslConfig() {
  if (process.env.NODE_ENV === 'test' && process.env.PPBF_POSTGRES_DISABLE_SSL === 'true') return false;
  return { rejectUnauthorized: true };
}

function usage() {
  console.log(`PPBF/SHADOW research intake importer

Validates the complete research package by default. It writes only when --apply
is present, and then only to an explicitly declared PostgreSQL target.

Required for validation:
  PPBF_ORG_ID
  SEED_ACCOUNT_ID

Required for --apply:
  AZURE_POSTGRES_CONNECTION_STRING
  PPBF_EXPECTED_POSTGRES_HOSTNAME
  PPBF_EXPECTED_POSTGRES_DATABASE

Optional:
  PPBF_RESEARCH_SEED_DIR

Examples:
  PPBF_ORG_ID=... SEED_ACCOUNT_ID=... npm run seed:shadow:research:dry
  PPBF_ORG_ID=... SEED_ACCOUNT_ID=... npm run seed:shadow:research -- --apply

The importer never approves evidence. New source/document rows retain the
database defaults pending_review + unverified, so retrieval remains human-gated.`);
}

export async function run() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    usage();
    return;
  }

  const apply = process.argv.includes('--apply');
  const organizationId = required(process.env.PPBF_ORG_ID, 'MISSING_PPBF_ORG_ID');
  const accountId = required(process.env.SEED_ACCOUNT_ID, 'MISSING_SEED_ACCOUNT_ID');
  const seedDir = process.env.PPBF_RESEARCH_SEED_DIR
    ? path.resolve(process.env.PPBF_RESEARCH_SEED_DIR)
    : DEFAULT_SEED_DIR;

  let actorRole = 'platform_owner';
  let client = null;
  let target = null;

  if (apply) {
    const connectionString = required(
      process.env.AZURE_POSTGRES_CONNECTION_STRING,
      'MISSING_AZURE_POSTGRES_CONNECTION_STRING',
    );
    target = assertDeclaredWriteTargetFromEnv(connectionString);
    client = new Client({ connectionString, ssl: sslConfig() });
    await client.connect();
    const actor = await assertActor(client, organizationId, accountId);
    actorRole = actor.role;
  }

  try {
    const seed = await loadSeedPackage({ seedDir, organizationId, accountId, createdByRole: actorRole });
    const summary = {
      mode: apply ? 'apply' : 'dry-run',
      organization_id: organizationId,
      target: target ? `${target.hostname}/${target.database}` : null,
      counts: Object.fromEntries(Object.entries(seed).map(([name, rows]) => [name, rows.length])),
      approval_state: 'pending_review',
      embeddings_generated: false,
    };

    if (apply) await importSeedPackage(client, seed, organizationId);
    console.log(JSON.stringify(summary, null, 2));
    console.log(apply ? 'SHADOW RESEARCH IMPORT PASS' : 'SHADOW RESEARCH DRY-RUN PASS');
  } finally {
    if (client) await client.end();
  }
}

if (process.argv[1] === __filename) {
  try {
    await run();
  } catch (error) {
    console.error('SHADOW RESEARCH IMPORT FAIL');
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
