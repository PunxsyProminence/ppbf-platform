import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';
import { emitShadowEvent } from './shadowEvents';
import { createShadowResearchRequirement, listShadowResearchRequirements } from './shadowResearch';
import { writeShadowTelemetryEvent } from './shadowTelemetry';

export type ShadowLibrarySourceType =
  | 'peer_reviewed'
  | 'clinical_guideline'
  | 'governing_body'
  | 'coach_observation'
  | 'athlete_self_report'
  | 'sensor_data'
  | 'internal_policy'
  | 'textbook'
  | 'media'
  | 'other';

export type ShadowLibrarySourceStatus = 'active' | 'archived' | 'rejected' | 'quarantined';

export type ShadowLibraryIngestState =
  | 'pending'
  | 'extracting'
  | 'chunking'
  | 'embedding'
  | 'indexed'
  | 'failed'
  | 'quarantined';

export type ShadowCoverageState = 'covered' | 'partial' | 'uncovered' | 'unknown';
export type ShadowLibraryScope = 'master' | 'scoped' | 'subject';
export type ShadowLibraryClaimStatus = 'supported' | 'weak' | 'unsupported';

export interface ShadowLibrarySourceRow {
  source_id: string;
  organization_id: string;
  title: string;
  publisher: string | null;
  source_type: ShadowLibrarySourceType;
  authority_tier: number;
  url: string | null;
  publication_date: string | null;
  status: ShadowLibrarySourceStatus;
  metadata: Record<string, unknown>;
  created_by_account_id: string | null;
  created_by_role: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShadowLibraryDocumentRow {
  document_id: string;
  source_id: string;
  organization_id: string;
  subject_id: string | null;
  document_name: string;
  blob_path: string | null;
  content_sha256: string | null;
  ingest_state: ShadowLibraryIngestState;
  extraction_error: string | null;
  metadata: Record<string, unknown>;
  created_by_account_id: string | null;
  created_by_role: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShadowLibraryChunkRow {
  chunk_id: string;
  document_id: string;
  source_id: string;
  organization_id: string;
  subject_id: string | null;
  ordinal: number;
  text_content: string;
  metadata: Record<string, unknown>;
  created_by_account_id: string | null;
  created_by_role: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShadowLibrarySearchResult {
  chunk_id: string;
  document_id: string;
  source_id: string;
  subject_id: string | null;
  ordinal: number;
  document_name: string;
  source_title: string;
  source_publisher: string | null;
  source_type: string;
  authority_tier: number;
  source_status: string;
  publication_date: string | null;
  text_content: string;
  score: number;
}

export interface ShadowLibraryClaimResult {
  answer: string;
  status: ShadowLibraryClaimStatus;
  confidence: number;
  evidence: ShadowLibrarySearchResult[];
  researchRequirementId: number | null;
}

export interface ShadowCapabilityCoverageRow {
  capability_map_id: string;
  organization_id: string;
  capability_key: string;
  required_source_types: string[];
  minimum_authority_tier: number;
  minimum_source_count: number;
  coverage_state: ShadowCoverageState;
  matched_sources: number;
  last_evaluated_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ShadowCoverageComputationRow {
  capability_map_id: string;
  capability_key: string;
  required_source_types: string[];
  minimum_authority_tier: number;
  minimum_source_count: number;
  matched_sources: number;
}

function clampAuthorityTier(value: number): number {
  if (!Number.isFinite(value)) {
    return 3;
  }
  return Math.max(1, Math.min(5, Math.trunc(value)));
}

function clampSourceCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.min(100, Math.trunc(value)));
}

function normalizeSearchScope(input: {
  scope?: ShadowLibraryScope;
  subjectId?: string | null;
  actorRole?: string;
  athleteId?: string | null;
}) {
  const requestedSubjectId = input.subjectId?.trim() || null;
  const actorAthleteId = input.actorRole === 'athlete' ? input.athleteId?.trim() || null : null;
  const effectiveSubjectId = requestedSubjectId || actorAthleteId;

  return {
    scope: input.scope ?? 'scoped',
    effectiveSubjectId,
  } as const;
}

function tokenizeQuery(queryText: string): string[] {
  return queryText
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((value) => value.trim())
    .filter((value) => value.length >= 3)
    .slice(0, 8);
}

function buildClaimNarrative(results: ShadowLibrarySearchResult[]): string {
  const topEvidence = results.slice(0, 3);
  const sourceSummary = topEvidence
    .map((item) => `${item.source_title} (tier ${item.authority_tier})`)
    .join('; ');
  const snippetSummary = topEvidence
    .map((item) => item.text_content.trim())
    .join(' ')
    .slice(0, 500);

  return `Library-backed answer from current SHADOW evidence: ${snippetSummary}${snippetSummary.endsWith('.') ? '' : '.'} Primary sources: ${sourceSummary}.`;
}

function isCanonicalDoctrineResult(result: ShadowLibrarySearchResult | undefined, scope: ShadowLibraryScope): boolean {
  if (!result) {
    return false;
  }

  return (
    scope === 'master'
    && result.source_type === 'internal_policy'
    && result.authority_tier === 1
    && result.document_name === 'SHADOW Canonical Authority Model'
  );
}

async function ensureClaimResearchRequirement(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: string;
  scope: ShadowLibraryScope;
  subjectId: string | null;
  question: string;
  status: ShadowLibraryClaimStatus;
  evidenceCount: number;
  distinctSourceCount: number;
}): Promise<number | null> {
  if (input.status === 'supported') {
    return null;
  }

  const openItems = await listShadowResearchRequirements(input.organizationId, 'open');
  const duplicate = openItems.find((item) => {
    const metadata = (item.metadata ?? {}) as Record<string, unknown>;
    return metadata.question === input.question && metadata.scope === input.scope && metadata.subject_id === input.subjectId;
  });

  if (duplicate) {
    return duplicate.research_requirement_id;
  }

  return createShadowResearchRequirement({
    organizationId: input.organizationId,
    sourceEventName: 'SHADOW_LIBRARY_CLAIM_GAP_DETECTED',
    sourceEntityType: 'shadow_library_claim',
    sourceEntityId: `${input.scope}:${input.subjectId ?? 'global'}:${Date.now()}`,
    researchRequirement: `Strengthen SHADOW Library evidence for ${input.scope} claim`,
    knowledgeGap: `Question lacks sufficient SHADOW Library evidence: ${input.question}. Evidence count: ${input.evidenceCount}. Distinct sources: ${input.distinctSourceCount}.`,
    evidenceLabel: input.subjectId,
    sourceStatus: input.status === 'unsupported' ? 'missing' : 'weak',
    sourceConfidenceTier: 'INSUFFICIENT',
    sourceVerificationState: 'unknown',
    createdByAccountId: input.actorAccountId,
    createdByRole: input.actorRole,
    metadata: {
      question: input.question,
      scope: input.scope,
      subject_id: input.subjectId,
      evidence_count: input.evidenceCount,
      distinct_source_count: input.distinctSourceCount,
      status: input.status,
    },
  });
}

function buildCoverageGapResearchFields(row: ShadowCoverageComputationRow, coverageState: ShadowCoverageState) {
  const requiredTypes = row.required_source_types.length > 0 ? row.required_source_types.join(', ') : 'any verified source type';
  const requirement = `Close SHADOW Library coverage gap for capability ${row.capability_key}`;
  const knowledgeGap =
    coverageState === 'uncovered'
      ? `No qualifying SHADOW Library sources currently support capability ${row.capability_key}. Required source types: ${requiredTypes}. Minimum authority tier: ${row.minimum_authority_tier}. Minimum source count: ${row.minimum_source_count}.`
      : `Capability ${row.capability_key} has only ${row.matched_sources} qualifying sources and requires ${row.minimum_source_count}. Required source types: ${requiredTypes}. Minimum authority tier: ${row.minimum_authority_tier}.`;

  return {
    requirement,
    knowledgeGap,
    sourceStatus: coverageState === 'uncovered' ? 'missing' : 'weak',
  } as const;
}

async function ensureCoverageGapResearchRequirement(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: string;
  row: ShadowCoverageComputationRow;
  coverageState: ShadowCoverageState;
}): Promise<void> {
  if (input.coverageState === 'covered' || input.coverageState === 'unknown') {
    return;
  }

  const openItems = await listShadowResearchRequirements(input.organizationId, 'open');
  const duplicate = openItems.some((item) => {
    const metadata = (item.metadata ?? {}) as Record<string, unknown>;
    return metadata.capability_key === input.row.capability_key && metadata.coverage_state === input.coverageState;
  });

  if (duplicate) {
    return;
  }

  const fields = buildCoverageGapResearchFields(input.row, input.coverageState);

  await createShadowResearchRequirement({
    organizationId: input.organizationId,
    sourceEventName: 'SHADOW_LIBRARY_CAPABILITY_GAP_DETECTED',
    sourceEntityType: 'shadow_library_capability_map',
    sourceEntityId: input.row.capability_key,
    researchRequirement: fields.requirement,
    knowledgeGap: fields.knowledgeGap,
    evidenceLabel: input.row.capability_key,
    sourceStatus: fields.sourceStatus,
    sourceConfidenceTier: 'INSUFFICIENT',
    sourceVerificationState: 'unknown',
    createdByAccountId: input.actorAccountId,
    createdByRole: input.actorRole,
    metadata: {
      capability_key: input.row.capability_key,
      coverage_state: input.coverageState,
      matched_sources: input.row.matched_sources,
      minimum_source_count: input.row.minimum_source_count,
      minimum_authority_tier: input.row.minimum_authority_tier,
      required_source_types: input.row.required_source_types,
    },
  });

  await emitShadowEvent({
    organizationId: input.organizationId,
    eventName: 'SHADOW_LIBRARY_CAPABILITY_GAP_DETECTED',
    entityType: 'shadow_library_capability_map',
    entityId: input.row.capability_key,
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    payload: {
      capability_key: input.row.capability_key,
      coverage_state: input.coverageState,
      matched_sources: input.row.matched_sources,
      minimum_source_count: input.row.minimum_source_count,
    },
  });
}

export async function createShadowLibrarySource(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: string;
  title: string;
  publisher?: string | null;
  sourceType: ShadowLibrarySourceType;
  authorityTier?: number;
  url?: string | null;
  publicationDate?: string | null;
  status?: ShadowLibrarySourceStatus;
  metadata?: Record<string, unknown>;
}): Promise<ShadowLibrarySourceRow> {
  const sourceId = `source_${randomUUID()}`;

  const row = await queryOne<ShadowLibrarySourceRow>(
    `insert into pilot.shadow_library_sources
      (source_id, organization_id, title, publisher, source_type, authority_tier, url, publication_date, status, metadata, created_by_account_id, created_by_role)
     values ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10::jsonb,$11,$12)
     returning *`,
    [
      sourceId,
      input.organizationId,
      input.title.trim(),
      input.publisher?.trim() || null,
      input.sourceType,
      clampAuthorityTier(input.authorityTier ?? 3),
      input.url?.trim() || null,
      input.publicationDate?.trim() || null,
      input.status ?? 'active',
      JSON.stringify(input.metadata ?? {}),
      input.actorAccountId,
      input.actorRole,
    ],
  );

  if (!row) {
    throw new Error('Unable to create SHADOW Library source.');
  }

  await emitShadowEvent({
    organizationId: input.organizationId,
    eventName: 'SHADOW_LIBRARY_SOURCE_CREATED',
    entityType: 'shadow_library_source',
    entityId: row.source_id,
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    payload: {
      source_type: row.source_type,
      authority_tier: row.authority_tier,
      status: row.status,
      title: row.title,
    },
  });

  await writeShadowTelemetryEvent({
    organizationId: input.organizationId,
    metricName: 'shadow.library.source.create',
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    dimensions: {
      source_type: row.source_type,
      authority_tier: row.authority_tier,
      status: row.status,
    },
  });

  return row;
}

export async function listShadowLibrarySources(input: {
  organizationId: string;
  sourceType?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<ShadowLibrarySourceRow[]> {
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 50)));
  const offset = Math.max(0, Math.trunc(input.offset ?? 0));

  return query<ShadowLibrarySourceRow>(
    `select *
     from pilot.shadow_library_sources
     where organization_id = $1
       and ($2::text is null or source_type = $2)
       and ($3::text is null or status = $3)
     order by created_at desc
     limit $4
     offset $5`,
    [input.organizationId, input.sourceType?.trim() || null, input.status?.trim() || null, limit, offset],
  );
}

export async function createShadowLibraryDocument(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: string;
  sourceId: string;
  documentName: string;
  subjectId?: string | null;
  blobPath?: string | null;
  contentSha256?: string | null;
  ingestState?: ShadowLibraryIngestState;
  metadata?: Record<string, unknown>;
}): Promise<ShadowLibraryDocumentRow> {
  const source = await queryOne<{ source_id: string }>(
    `select source_id
     from pilot.shadow_library_sources
     where source_id = $1 and organization_id = $2`,
    [input.sourceId, input.organizationId],
  );

  if (!source) {
    throw new Error('Source does not exist in this organization.');
  }

  const documentId = `doc_${randomUUID()}`;
  const row = await queryOne<ShadowLibraryDocumentRow>(
    `insert into pilot.shadow_library_documents
      (document_id, source_id, organization_id, subject_id, document_name, blob_path, content_sha256, ingest_state, metadata, created_by_account_id, created_by_role)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
     returning *`,
    [
      documentId,
      input.sourceId,
      input.organizationId,
      input.subjectId?.trim() || null,
      input.documentName.trim(),
      input.blobPath?.trim() || null,
      input.contentSha256?.trim() || null,
      input.ingestState ?? 'pending',
      JSON.stringify(input.metadata ?? {}),
      input.actorAccountId,
      input.actorRole,
    ],
  );

  if (!row) {
    throw new Error('Unable to create SHADOW Library document.');
  }

  await emitShadowEvent({
    organizationId: input.organizationId,
    eventName: 'SHADOW_LIBRARY_DOCUMENT_REGISTERED',
    entityType: 'shadow_library_document',
    entityId: row.document_id,
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    payload: {
      source_id: row.source_id,
      ingest_state: row.ingest_state,
      subject_id: row.subject_id,
    },
  });

  await writeShadowTelemetryEvent({
    organizationId: input.organizationId,
    metricName: 'shadow.library.document.register',
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    dimensions: {
      ingest_state: row.ingest_state,
      subject_scoped: Boolean(row.subject_id),
    },
  });

  return row;
}

export async function createShadowLibraryChunk(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: string;
  documentId: string;
  ordinal: number;
  textContent: string;
  metadata?: Record<string, unknown>;
}): Promise<ShadowLibraryChunkRow> {
  const document = await queryOne<{
    document_id: string;
    source_id: string;
    subject_id: string | null;
  }>(
    `select document_id, source_id, subject_id
     from pilot.shadow_library_documents
     where document_id = $1 and organization_id = $2`,
    [input.documentId, input.organizationId],
  );

  if (!document) {
    throw new Error('Document does not exist in this organization.');
  }

  const chunkId = `chunk_${randomUUID()}`;
  const row = await queryOne<ShadowLibraryChunkRow>(
    `insert into pilot.shadow_library_chunks
      (chunk_id, document_id, source_id, organization_id, subject_id, ordinal, text_content, metadata, created_by_account_id, created_by_role)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
     returning *`,
    [
      chunkId,
      document.document_id,
      document.source_id,
      input.organizationId,
      document.subject_id,
      Math.max(0, Math.trunc(input.ordinal)),
      input.textContent.trim(),
      JSON.stringify(input.metadata ?? {}),
      input.actorAccountId,
      input.actorRole,
    ],
  );

  if (!row) {
    throw new Error('Unable to create SHADOW Library chunk.');
  }

  await query(
    `update pilot.shadow_library_documents
     set ingest_state = 'indexed',
         updated_at = now()
     where document_id = $1 and organization_id = $2`,
    [document.document_id, input.organizationId],
  );

  await emitShadowEvent({
    organizationId: input.organizationId,
    eventName: 'SHADOW_LIBRARY_CHUNK_REGISTERED',
    entityType: 'shadow_library_chunk',
    entityId: row.chunk_id,
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    payload: {
      document_id: row.document_id,
      source_id: row.source_id,
      ordinal: row.ordinal,
      subject_id: row.subject_id,
    },
  });

  await writeShadowTelemetryEvent({
    organizationId: input.organizationId,
    metricName: 'shadow.library.chunk.register',
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    dimensions: {
      subject_scoped: Boolean(row.subject_id),
      ordinal: row.ordinal,
    },
  });

  return row;
}

export async function searchShadowLibrary(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: string;
  athleteId?: string | null;
  scope?: ShadowLibraryScope;
  subjectId?: string | null;
  queryText: string;
  limit?: number;
}): Promise<ShadowLibrarySearchResult[]> {
  const normalized = normalizeSearchScope({
    scope: input.scope,
    subjectId: input.subjectId,
    actorRole: input.actorRole,
    athleteId: input.athleteId,
  });
  const terms = tokenizeQuery(input.queryText);
  const limit = Math.max(1, Math.min(20, Math.trunc(input.limit ?? 8)));
  const wholeQuery = input.queryText.trim().toLowerCase();
  const termPatterns = terms.map((term) => `%${term}%`);

  const rows = await query<ShadowLibrarySearchResult>(
    `select
       c.chunk_id,
       c.document_id,
       c.source_id,
       c.subject_id,
      c.ordinal,
       d.document_name,
       s.title as source_title,
       s.publisher as source_publisher,
       s.source_type,
       s.authority_tier,
       s.status as source_status,
       s.publication_date::text as publication_date,
       c.text_content,
       (
         case when lower(c.text_content) like '%' || $3 || '%' then 40 else 0 end
         + case when lower(d.document_name) like '%' || $3 || '%' then 20 else 0 end
         + case when lower(s.title) like '%' || $3 || '%' then 25 else 0 end
         + case when cardinality($4::text[]) > 0 then (
             select count(*)::int * 8
             from unnest($4::text[]) as term
             where lower(c.text_content) like term
                or lower(d.document_name) like term
                or lower(s.title) like term
           ) else 0 end
         + (6 - s.authority_tier) * 3
       )::float as score
     from pilot.shadow_library_chunks c
     join pilot.shadow_library_documents d on d.document_id = c.document_id and d.organization_id = c.organization_id
     join pilot.shadow_library_sources s on s.source_id = c.source_id and s.organization_id = c.organization_id
     where c.organization_id = $1
       and s.status = 'active'
       and (
         $2::text is null
         or c.subject_id is null
         or c.subject_id = $2
       )
       and (
         lower(c.text_content) like '%' || $3 || '%'
         or lower(d.document_name) like '%' || $3 || '%'
         or lower(s.title) like '%' || $3 || '%'
         or exists (
           select 1
           from unnest($4::text[]) as term
           where lower(c.text_content) like term
              or lower(d.document_name) like term
              or lower(s.title) like term
         )
       )
     order by score desc, s.authority_tier asc, c.ordinal asc, c.created_at asc
     limit $5`,
    [input.organizationId, normalized.effectiveSubjectId, wholeQuery, termPatterns, limit],
  );

  await writeShadowTelemetryEvent({
    organizationId: input.organizationId,
    metricName: 'shadow.library.search',
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    dimensions: {
      scope: normalized.scope,
      result_count: rows.length,
      subject_scoped: Boolean(normalized.effectiveSubjectId),
    },
  });

  return rows;
}

export async function createShadowLibraryClaim(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: string;
  athleteId?: string | null;
  scope?: ShadowLibraryScope;
  subjectId?: string | null;
  question: string;
  limit?: number;
}): Promise<ShadowLibraryClaimResult> {
  const normalized = normalizeSearchScope({
    scope: input.scope,
    subjectId: input.subjectId,
    actorRole: input.actorRole,
    athleteId: input.athleteId,
  });

  const evidence = await searchShadowLibrary({
    organizationId: input.organizationId,
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    athleteId: input.athleteId,
    scope: normalized.scope,
    subjectId: normalized.effectiveSubjectId,
    queryText: input.question,
    limit: input.limit ?? 5,
  });

  const distinctSourceCount = new Set(evidence.map((item) => item.source_id)).size;
  const canonicalDoctrine = isCanonicalDoctrineResult(evidence[0], normalized.scope);
  let status: ShadowLibraryClaimStatus;
  let confidence: number;

  if (canonicalDoctrine && evidence.length >= 1) {
    status = 'supported';
    confidence = 0.82;
  } else if (distinctSourceCount >= 2 && evidence.length >= 2) {
    status = 'supported';
    confidence = 0.78;
  } else if (evidence.length >= 1) {
    status = 'weak';
    confidence = 0.46;
  } else {
    status = 'unsupported';
    confidence = 0.12;
  }

  const researchRequirementId = await ensureClaimResearchRequirement({
    organizationId: input.organizationId,
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    scope: normalized.scope,
    subjectId: normalized.effectiveSubjectId,
    question: input.question.trim(),
    status,
    evidenceCount: evidence.length,
    distinctSourceCount,
  });

  const answer =
    status === 'unsupported'
      ? 'SHADOW Library does not currently have qualifying evidence for this question. A research requirement has been opened or matched so the gap becomes organizational learning work.'
      : buildClaimNarrative(evidence);

  await emitShadowEvent({
    organizationId: input.organizationId,
    eventName: status === 'supported' ? 'SHADOW_LIBRARY_CLAIM_SUPPORTED' : 'SHADOW_LIBRARY_CLAIM_GAP_DETECTED',
    entityType: 'shadow_library_claim',
    entityId: `${normalized.scope}:${Date.now()}`,
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    payload: {
      scope: normalized.scope,
      subject_id: normalized.effectiveSubjectId,
      status,
      evidence_count: evidence.length,
      distinct_source_count: distinctSourceCount,
      research_requirement_id: researchRequirementId,
    },
  });

  await writeShadowTelemetryEvent({
    organizationId: input.organizationId,
    metricName: 'shadow.library.claim',
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    dimensions: {
      scope: normalized.scope,
      status,
      evidence_count: evidence.length,
      distinct_source_count: distinctSourceCount,
    },
  });

  return {
    answer,
    status,
    confidence,
    evidence,
    researchRequirementId,
  };
}

export async function upsertShadowCapabilityMap(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: string;
  capabilityKey: string;
  requiredSourceTypes?: string[];
  minimumAuthorityTier?: number;
  minimumSourceCount?: number;
}): Promise<void> {
  const capabilityMapId = `cap_${randomUUID()}`;

  await query(
    `insert into pilot.shadow_library_capability_map
      (capability_map_id, organization_id, capability_key, required_source_types, minimum_authority_tier, minimum_source_count, coverage_state)
     values ($1,$2,$3,$4::text[],$5,$6,'unknown')
     on conflict (organization_id, capability_key)
     do update
       set required_source_types = excluded.required_source_types,
           minimum_authority_tier = excluded.minimum_authority_tier,
           minimum_source_count = excluded.minimum_source_count,
           updated_at = now()`,
    [
      capabilityMapId,
      input.organizationId,
      input.capabilityKey.trim(),
      input.requiredSourceTypes && input.requiredSourceTypes.length > 0 ? input.requiredSourceTypes : [],
      clampAuthorityTier(input.minimumAuthorityTier ?? 3),
      clampSourceCount(input.minimumSourceCount ?? 1),
    ],
  );

  await emitShadowEvent({
    organizationId: input.organizationId,
    eventName: 'SHADOW_LIBRARY_CAPABILITY_RULE_UPSERTED',
    entityType: 'shadow_library_capability_map',
    entityId: input.capabilityKey,
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    payload: {
      required_source_types: input.requiredSourceTypes ?? [],
      minimum_authority_tier: clampAuthorityTier(input.minimumAuthorityTier ?? 3),
      minimum_source_count: clampSourceCount(input.minimumSourceCount ?? 1),
    },
  });
}

export async function recomputeShadowCapabilityCoverage(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: string;
}): Promise<ShadowCapabilityCoverageRow[]> {
  const rows = await query<ShadowCoverageComputationRow>(
    `select
       cm.capability_map_id,
       cm.capability_key,
       cm.required_source_types,
       cm.minimum_authority_tier,
       cm.minimum_source_count,
       coalesce(ms.matched_sources, 0)::int as matched_sources
     from pilot.shadow_library_capability_map cm
     left join lateral (
       select count(distinct s.source_id) as matched_sources
       from pilot.shadow_library_sources s
       where s.organization_id = cm.organization_id
         and s.status = 'active'
         and s.authority_tier <= cm.minimum_authority_tier
         and (
           coalesce(array_length(cm.required_source_types, 1), 0) = 0
           or s.source_type = any(cm.required_source_types)
         )
     ) ms on true
     where cm.organization_id = $1`,
    [input.organizationId],
  );

  for (const row of rows) {
    let coverageState: ShadowCoverageState;
    if (row.matched_sources <= 0) {
      coverageState = 'uncovered';
    } else if (row.matched_sources < row.minimum_source_count) {
      coverageState = 'partial';
    } else {
      coverageState = 'covered';
    }

    await query(
      `update pilot.shadow_library_capability_map
       set coverage_state = $3,
           last_evaluated_at = now(),
           updated_at = now()
       where organization_id = $1 and capability_map_id = $2`,
      [input.organizationId, row.capability_map_id, coverageState],
    );

    await ensureCoverageGapResearchRequirement({
      organizationId: input.organizationId,
      actorAccountId: input.actorAccountId,
      actorRole: input.actorRole,
      row,
      coverageState,
    });
  }

  await writeShadowTelemetryEvent({
    organizationId: input.organizationId,
    metricName: 'shadow.library.coverage.recompute',
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    dimensions: {
      rules: rows.length,
    },
  });

  await emitShadowEvent({
    organizationId: input.organizationId,
    eventName: 'SHADOW_LIBRARY_CAPABILITY_COVERAGE_RECOMPUTED',
    entityType: 'shadow_library_capability_map',
    entityId: input.organizationId,
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    payload: {
      rules: rows.length,
    },
  });

  return listShadowCapabilityCoverage(input.organizationId);
}

export async function listShadowCapabilityCoverage(organizationId: string): Promise<ShadowCapabilityCoverageRow[]> {
  return query<ShadowCapabilityCoverageRow>(
    `select
       cm.capability_map_id,
       cm.organization_id,
       cm.capability_key,
       cm.required_source_types,
       cm.minimum_authority_tier,
       cm.minimum_source_count,
       cm.coverage_state,
       cm.last_evaluated_at,
       cm.created_at,
       cm.updated_at,
       coalesce(ms.matched_sources, 0)::int as matched_sources
     from pilot.shadow_library_capability_map cm
     left join lateral (
       select count(distinct s.source_id) as matched_sources
       from pilot.shadow_library_sources s
       where s.organization_id = cm.organization_id
         and s.status = 'active'
         and s.authority_tier <= cm.minimum_authority_tier
         and (
           coalesce(array_length(cm.required_source_types, 1), 0) = 0
           or s.source_type = any(cm.required_source_types)
         )
     ) ms on true
     where cm.organization_id = $1
     order by cm.capability_key asc`,
    [organizationId],
  );
}
