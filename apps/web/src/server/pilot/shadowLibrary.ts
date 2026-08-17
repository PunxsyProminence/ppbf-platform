import { randomUUID } from 'node:crypto';

import { assertActorCanAccessAthlete } from './access';
import type { PilotRole } from './contracts';
import { query, queryOne } from './db';
import { libraryRetrievalOrganizationIds } from './platformLibraryScope';
import { cosineSimilarity, embedText, getEmbeddingDeploymentName, isSemanticLibrarySearchEnabled } from './shadowEmbeddings';
import { emitShadowEvent } from './shadowEvents';
import { createShadowResearchRequirement, listShadowResearchRequirements, type ShadowResearchRequirementRow } from './shadowResearch';
import { writeShadowTelemetryEvent } from './shadowTelemetry';

// Below this cosine similarity, the best semantic match is noise rather than
// relevance, and the search falls back to keywords instead of citing the
// chunk that merely lost least badly. Deliberately permissive: embeddings
// separate related from unrelated text well above this line, and the
// downstream evidence review gates still apply to whatever is returned.
// Exported so pilotOpsReadiness.ts can report the real value.
export const SEMANTIC_SCORE_FLOOR = 0.15;

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
export type ShadowLibraryApprovalState = 'pending_review' | 'approved' | 'rejected';
export type ShadowLibraryVerificationState = 'unverified' | 'verified';

export type ShadowLibraryIngestState =
  | 'pending'
  | 'extracting'
  | 'chunking'
  | 'embedding'
  | 'indexed'
  | 'failed'
  | 'quarantined';

export type ShadowCoverageState = 'covered' | 'partial' | 'uncovered' | 'unknown';
// 'master' was removed deliberately. It selected no subject predicate at all in
// the search query, so it returned every athlete-scoped chunk in an organization
// regardless of whether the caller was authorized for those athletes -- the
// per-athlete check in searchShadowLibrary only runs for 'subject' scope. It had
// no callers (the sole production caller, retrieveShadowEvidenceBundle, always
// passes 'subject' or 'scoped'), so removing it changes no behavior today and
// deletes the only code path able to read across athletes.
//
// If an organization-wide need appears later, do NOT reintroduce a wildcard.
// Expand it to an explicit list of athlete ids the caller has been checked
// against, so that "everything" is never representable as a single value.
export type ShadowLibraryScope = 'scoped' | 'subject';
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
  approval_state: ShadowLibraryApprovalState;
  verification_state: ShadowLibraryVerificationState;
  approved_by_account_id: string | null;
  approved_at: string | null;
  verified_by_account_id: string | null;
  verified_at: string | null;
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
  index_completed_at: string | null;
  approval_state: ShadowLibraryApprovalState;
  verification_state: ShadowLibraryVerificationState;
  approved_by_account_id: string | null;
  approved_at: string | null;
  verified_by_account_id: string | null;
  verified_at: string | null;
  extraction_error: string | null;
  metadata: Record<string, unknown>;
  created_by_account_id: string | null;
  created_by_role: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShadowLibraryReviewDocumentRow {
  document_id: string;
  source_id: string;
  document_name: string;
  subject_id: string | null;
  ingest_state: ShadowLibraryIngestState;
  index_completed_at: string | null;
  approval_state: ShadowLibraryApprovalState;
  verification_state: ShadowLibraryVerificationState;
  extraction_error: string | null;
  chunk_count: number;
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
  // Extracted from the chunk's own metadata jsonb -- the quality-weighted
  // evidence tier rule (shadowEvidenceTier.ts) reads these. Null for a
  // chunk whose metadata does not carry the field (e.g. content seeded
  // before the research-program corpus existed), which
  // shadowEvidenceTier.ts's callers must treat as "not gradeable", never
  // as a passing grade.
  evidence_class: string | null;
  boxing_specificity: string | null;
}

export interface ShadowApprovedEvidenceExportRow {
  chunk_id: string;
  source_title: string;
  source_publisher: string | null;
  source_type: 'peer_reviewed' | 'clinical_guideline' | 'governing_body' | 'textbook';
  authority_tier: number;
  source_url: string | null;
  publication_date: string | null;
  text_content: string;
}

export interface ShadowLibraryClaimResult {
  answer: string;
  status: ShadowLibraryClaimStatus;
  // NOT a calibrated probability. This is one of exactly three fixed values
  // (0.78 / 0.46 / 0.12) selected solely by which `status` band evidence.length
  // and distinctSourceCount land in below -- a precise-looking float standing
  // in for an ordinal judgment. Kept for existing callers rather than removed,
  // but `status` is the honest signal; a caller wanting the reasoning behind
  // it should read `evidenceCount` / `distinctSourceCount`, not this number.
  confidence: number;
  evidenceCount: number;
  distinctSourceCount: number;
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

// Exported: drillVersioning.ts reuses this exact check for adopting/declining
// a drill change proposal. Shared coaching content read by every athlete in
// the org needs the same reviewer tier as SHADOW evidence review -- one
// source of truth for "who may approve organization-wide content" rather
// than a second copy that could drift from this one.
export function requireEvidenceReviewer(role: PilotRole): void {
  if (role !== 'organization_admin' && role !== 'admin' && role !== 'platform_owner') {
    throw new Error('Forbidden: SHADOW evidence review requires an organization administrator');
  }
}

function validateReviewState(
  approvalState: ShadowLibraryApprovalState,
  verificationState: ShadowLibraryVerificationState,
): void {
  if (
    (approvalState === 'approved' && verificationState !== 'verified')
    || (approvalState !== 'approved' && verificationState === 'verified')
  ) {
    throw new Error('Approved SHADOW evidence must also be verified');
  }
}

export function normalizeSearchScope(input: {
  scope?: ShadowLibraryScope;
  subjectId?: string | null;
  actorRole?: PilotRole;
  athleteId?: string | null;
}) {
  const requestedSubjectId = input.subjectId?.trim() || null;
  const requestedScope = input.scope ?? 'scoped';

  if (input.actorRole === 'athlete') {
    const actorAthleteId = input.athleteId?.trim() || null;
    if (!actorAthleteId) {
      throw new Error('Forbidden: athlete SHADOW library access requires an athlete identity');
    }
    if (requestedSubjectId && requestedSubjectId !== actorAthleteId) {
      throw new Error('Forbidden: athlete cannot search another subject');
    }
    return {
      scope: 'subject' as const,
      effectiveSubjectId: actorAthleteId,
    };
  }

  // Fail closed on anything that is not a recognized scope. The type union
  // already blocks this for TypeScript callers; this guard covers values
  // arriving from JSON or from a future untyped call site.
  if (requestedScope !== 'scoped' && requestedScope !== 'subject') {
    throw new Error('Forbidden: unrecognized SHADOW library scope');
  }
  if (requestedScope === 'subject' && !requestedSubjectId) {
    throw new Error('Missing SHADOW library subject');
  }

  return {
    scope: requestedScope,
    effectiveSubjectId: requestedScope === 'subject' ? requestedSubjectId : null,
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

interface ShadowClaimResearchRequirement {
  id: number;
  researchRequirement: string;
  knowledgeGap: string;
}

async function ensureClaimResearchRequirement(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: PilotRole;
  scope: ShadowLibraryScope;
  subjectId: string | null;
  question: string;
  status: ShadowLibraryClaimStatus;
  evidenceCount: number;
  distinctSourceCount: number;
}): Promise<ShadowClaimResearchRequirement | null> {
  if (input.status === 'supported') {
    return null;
  }

  const researchRequirement = `Strengthen SHADOW Library evidence for ${input.scope} claim`;
  const knowledgeGap = `Question lacks sufficient SHADOW Library evidence: ${input.question}. Evidence count: ${input.evidenceCount}. Distinct sources: ${input.distinctSourceCount}.`;

  const openItems = await listShadowResearchRequirements(input.organizationId, { status: 'open' });
  const duplicate = openItems.find((item) => {
    const metadata = (item.metadata ?? {}) as Record<string, unknown>;
    return metadata.question === input.question && metadata.scope === input.scope && metadata.subject_id === input.subjectId;
  });

  if (duplicate) {
    return { id: duplicate.research_requirement_id, researchRequirement, knowledgeGap };
  }

  const id = await createShadowResearchRequirement({
    organizationId: input.organizationId,
    sourceEventName: 'SHADOW_LIBRARY_CLAIM_GAP_DETECTED',
    sourceEntityType: 'shadow_library_claim',
    sourceEntityId: `${input.scope}:${input.subjectId ?? 'global'}:${Date.now()}`,
    researchRequirement,
    knowledgeGap,
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

  return { id, researchRequirement, knowledgeGap };
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
  /**
   * The org's open research requirements, fetched ONCE by the caller
   * (recomputeShadowCapabilityCoverage evaluates every capability rule in
   * one pass, and every row's dedup check reads the same list -- refetching
   * it per row was a full-list query for every non-covered rule instead of
   * one for the whole recompute). Each row here corresponds to a distinct
   * capability_map_id/capability_key, so no row's newly-created requirement
   * can ever be a duplicate a LATER row in the same pass needs to see: the
   * list snapshotted before the loop is exactly the set every row needs to
   * check against.
   */
  openItems: readonly ShadowResearchRequirementRow[];
}): Promise<void> {
  if (input.coverageState === 'covered' || input.coverageState === 'unknown') {
    return;
  }

  const duplicate = input.openItems.some((item) => {
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

/**
 * Narrow metadata update: the general-research classification label only
 * (issue #345 workflow 3 -- "human correction/confirmation of classification
 * must remain possible"). Deliberately NOT a general metadata editor: the
 * domain is validated by the caller against the shared taxonomy, jsonb_set
 * touches that one key, and nothing else about the source -- title, tier,
 * status, review state -- is reachable from here.
 */
export async function updateShadowLibrarySourceClassification(
  organizationId: string,
  sourceId: string,
  classificationDomain: string,
): Promise<ShadowLibrarySourceRow | null> {
  const row = await queryOne<ShadowLibrarySourceRow>(
    `update pilot.shadow_library_sources
     set metadata = jsonb_set(metadata, '{classification_domain}', to_jsonb($3::text), true),
         updated_at = now()
     where organization_id = $1 and source_id = $2
     returning *`,
    [organizationId, sourceId, classificationDomain],
  );
  return row;
}

export async function listShadowLibrarySources(input: {
  organizationId: string;
  sourceType?: string;
  status?: string;
  /** true filters to general-research registrations (metadata.general_research). */
  generalResearch?: boolean;
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
       and ($4::boolean is null or coalesce((metadata->>'general_research')::boolean, false) = $4)
     order by created_at desc
     limit $5
     offset $6`,
    [
      input.organizationId,
      input.sourceType?.trim() || null,
      input.status?.trim() || null,
      input.generalResearch ?? null,
      limit,
      offset,
    ],
  );
}

// Dedicated export boundary for the read-only research bridge. It deliberately
// excludes subject-scoped chunks and all observational/self-report source types,
// then reapplies the same source + document approval gate used by Library search.
export async function listApprovedGlobalEvidenceForResearchBridge(input: {
  organizationId: string;
  limit?: number;
}): Promise<ShadowApprovedEvidenceExportRow[]> {
  const limit = Math.max(1, Math.min(2_000, Math.trunc(input.limit ?? 1_000)));
  const allowedSourceTypes = ['peer_reviewed', 'clinical_guideline', 'governing_body', 'textbook'];

  return query<ShadowApprovedEvidenceExportRow>(
    `select
       c.chunk_id,
       s.title as source_title,
       s.publisher as source_publisher,
       s.source_type,
       s.authority_tier,
       s.url as source_url,
       s.publication_date::text as publication_date,
       c.text_content
     from pilot.shadow_library_chunks c
     join pilot.shadow_library_documents d
       on d.document_id = c.document_id
      and d.organization_id = c.organization_id
     join pilot.shadow_library_sources s
       on s.source_id = c.source_id
      and s.organization_id = c.organization_id
     where c.organization_id = $1
       and c.subject_id is null
       and d.subject_id is null
       and s.status = 'active'
       and s.approval_state = 'approved'
       and s.verification_state = 'verified'
       and d.ingest_state = 'indexed'
       and d.index_completed_at is not null
       and d.approval_state = 'approved'
       and d.verification_state = 'verified'
       and s.source_type = any($2::text[])
     order by s.authority_tier asc, s.title asc, c.ordinal asc
     limit $3`,
    [input.organizationId, allowedSourceTypes, limit],
  );
}

export async function listShadowLibraryReviewQueue(input: {
  organizationId: string;
  limit?: number;
}): Promise<{
  sources: ShadowLibrarySourceRow[];
  documents: ShadowLibraryReviewDocumentRow[];
}> {
  const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
  const [sources, documents] = await Promise.all([
    query<ShadowLibrarySourceRow>(
      `select *
       from pilot.shadow_library_sources
       where organization_id = $1
       order by
         case approval_state when 'pending_review' then 0 else 1 end,
         created_at desc
       limit $2`,
      [input.organizationId, limit],
    ),
    query<ShadowLibraryReviewDocumentRow>(
      `select
         d.document_id,
         d.source_id,
         d.document_name,
         d.subject_id,
         d.ingest_state,
         d.index_completed_at,
         d.approval_state,
         d.verification_state,
         d.extraction_error,
         count(c.chunk_id)::integer as chunk_count,
         d.created_at,
         d.updated_at
       from pilot.shadow_library_documents d
       left join pilot.shadow_library_chunks c
         on c.organization_id = d.organization_id
        and c.document_id = d.document_id
       where d.organization_id = $1
       group by
         d.document_id,
         d.source_id,
         d.document_name,
         d.subject_id,
         d.ingest_state,
         d.index_completed_at,
         d.approval_state,
         d.verification_state,
         d.extraction_error,
         d.created_at,
         d.updated_at
       order by
         case d.approval_state when 'pending_review' then 0 else 1 end,
         d.created_at desc
       limit $2`,
      [input.organizationId, limit],
    ),
  ]);
  return { sources, documents };
}

export async function reviewShadowLibrarySource(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: PilotRole;
  sourceId: string;
  approvalState: ShadowLibraryApprovalState;
  verificationState: ShadowLibraryVerificationState;
}): Promise<ShadowLibrarySourceRow> {
  requireEvidenceReviewer(input.actorRole);
  validateReviewState(input.approvalState, input.verificationState);

  const row = await queryOne<ShadowLibrarySourceRow>(
    `update pilot.shadow_library_sources
     set approval_state = $1,
         verification_state = $2,
         approved_by_account_id = case when $1 = 'approved' then $3 else null end,
         approved_at = case when $1 = 'approved' then now() else null end,
         verified_by_account_id = case when $2 = 'verified' then $3 else null end,
         verified_at = case when $2 = 'verified' then now() else null end,
         updated_at = now()
     where source_id = $4
       and organization_id = $5
     returning *`,
    [
      input.approvalState,
      input.verificationState,
      input.actorAccountId,
      input.sourceId,
      input.organizationId,
    ],
  );

  if (!row) {
    throw new Error('SHADOW_LIBRARY_SOURCE_NOT_FOUND');
  }
  return row;
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

  // Best-effort embedding at write time: when the embedding deployment is
  // configured, the chunk becomes semantically searchable immediately. A
  // failed or disabled embedding leaves the column NULL and the chunk still
  // fully usable through keyword search; the backfill script picks up NULLs
  // later. Never lets an embedding problem fail the registration the curator
  // just performed.
  try {
    const embedding = await embedText(row.text_content);
    if (embedding) {
      await query(
        `update pilot.shadow_library_chunks
         set embedding = $3::jsonb, embedding_model = $4
         where chunk_id = $1 and organization_id = $2`,
        [row.chunk_id, input.organizationId, JSON.stringify(embedding), getEmbeddingDeploymentName()],
      );
    }
  } catch (error) {
    console.error('SHADOW chunk embedding skipped', {
      errorClass: error instanceof Error ? error.name : typeof error,
    });
  }

  await query(
    `update pilot.shadow_library_documents
     set ingest_state = 'chunking',
         index_completed_at = null,
         approval_state = 'pending_review',
         verification_state = 'unverified',
         approved_by_account_id = null,
         approved_at = null,
         verified_by_account_id = null,
         verified_at = null,
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

export async function completeShadowLibraryDocumentIndexing(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: PilotRole;
  documentId: string;
}): Promise<ShadowLibraryDocumentRow> {
  requireEvidenceReviewer(input.actorRole);
  const row = await queryOne<ShadowLibraryDocumentRow>(
    `update pilot.shadow_library_documents d
     set ingest_state = 'indexed',
         index_completed_at = now(),
         updated_at = now()
     where d.document_id = $1
       and d.organization_id = $2
       and exists (
         select 1
         from pilot.shadow_library_chunks c
         where c.document_id = d.document_id
           and c.organization_id = d.organization_id
           and length(trim(c.text_content)) > 0
       )
     returning d.*`,
    [input.documentId, input.organizationId],
  );
  if (!row) {
    throw new Error('SHADOW document cannot be indexed without a non-empty organization-scoped chunk');
  }
  return row;
}

export async function reviewShadowLibraryDocument(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: PilotRole;
  documentId: string;
  approvalState: ShadowLibraryApprovalState;
  verificationState: ShadowLibraryVerificationState;
}): Promise<ShadowLibraryDocumentRow> {
  requireEvidenceReviewer(input.actorRole);
  validateReviewState(input.approvalState, input.verificationState);

  const row = await queryOne<ShadowLibraryDocumentRow>(
    `update pilot.shadow_library_documents
     set approval_state = $1,
         verification_state = $2,
         approved_by_account_id = case when $1 = 'approved' then $3 else null end,
         approved_at = case when $1 = 'approved' then now() else null end,
         verified_by_account_id = case when $2 = 'verified' then $3 else null end,
         verified_at = case when $2 = 'verified' then now() else null end,
         updated_at = now()
     where document_id = $4
       and organization_id = $5
       and (
         $1 <> 'approved'
         or (ingest_state = 'indexed' and index_completed_at is not null)
       )
     returning *`,
    [
      input.approvalState,
      input.verificationState,
      input.actorAccountId,
      input.documentId,
      input.organizationId,
    ],
  );

  if (!row) {
    throw new Error('SHADOW document is missing or has not completed indexing');
  }
  return row;
}

/**
 * Retrieval reads two shelves: the caller's own organization, and the platform
 * evidence baseline.
 *
 * Both queries below therefore filter `c.organization_id = any($1::text[])`
 * rather than `= $1`. The joins keep restating `d.organization_id =
 * c.organization_id`, which is what makes the widening safe: a platform chunk
 * can only ever pair with a platform document and a platform source, so
 * admitting a second organization to the candidate set cannot produce a row
 * assembled from two different tenants.
 *
 * Only the reads widen. Every write in this module stays on a single
 * organization_id, and listApprovedGlobalEvidenceForResearchBridge stays
 * organization-only on purpose -- it is an export, and including the baseline
 * would ship it out as though the gym had produced it.
 */
export async function searchShadowLibrary(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: PilotRole;
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
  const normalizedQuery = input.queryText.trim();
  if (!normalizedQuery) {
    throw new Error('Missing SHADOW library query');
  }
  const terms = tokenizeQuery(normalizedQuery);
  const requestedLimit = input.limit ?? 8;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new Error('Invalid SHADOW library result limit');
  }
  const limit = Math.min(20, requestedLimit);
  const wholeQuery = normalizedQuery.toLowerCase().slice(0, 1_000);
  const termPatterns = terms.map((term) => `%${term}%`);

  if (normalized.scope === 'subject' && normalized.effectiveSubjectId) {
    await assertActorCanAccessAthlete({
      accountId: input.actorAccountId,
      organizationId: input.organizationId,
      role: input.actorRole,
      athleteId: input.athleteId ?? null,
    }, normalized.effectiveSubjectId);
  }

  // Semantic path, when the embedding deployment is live: rank a bounded
  // candidate set (same approval/verification/scope filters as the keyword
  // query, restricted to chunks that HAVE an embedding) by cosine similarity
  // computed in-process. No pgvector, no index: at this library's scale the
  // candidate set is small, and keeping ranking in the application means the
  // keyword path below remains byte-for-byte the shipped behavior whenever
  // semantics is disabled, errors, or finds nothing relevant -- an embedding
  // outage degrades search, never breaks it.
  if (isSemanticLibrarySearchEnabled()) {
    const queryEmbedding = await embedText(normalizedQuery);
    if (queryEmbedding) {
      // Restricted to embedding_model = the CURRENT deployment, not merely
      // "has an embedding". Two different embedding models can share a
      // dimension count -- cosineSimilarity only guards dimension mismatch,
      // so a vector from a retired deployment would compare as a real-looking
      // but semantically meaningless score, clear SEMANTIC_SCORE_FLOOR by
      // chance, and get cited to a user as evidence. A model change must
      // degrade those rows to the keyword path, same as never having been
      // embedded, until the backfill catches up.
      const currentEmbeddingModel = getEmbeddingDeploymentName();
      const candidates = await query<ShadowLibrarySearchResult & { embedding: number[] }>(
        `select
           c.chunk_id, c.document_id, c.source_id, c.subject_id, c.ordinal,
           d.document_name,
           s.title as source_title, s.publisher as source_publisher,
           s.source_type, s.authority_tier, s.status as source_status,
           s.publication_date::text as publication_date,
           c.text_content, c.embedding,
           c.metadata->>'evidence_class' as evidence_class,
           c.metadata->>'boxing_specificity' as boxing_specificity,
           0::float as score
         from pilot.shadow_library_chunks c
         join pilot.shadow_library_documents d on d.document_id = c.document_id and d.organization_id = c.organization_id
         join pilot.shadow_library_sources s on s.source_id = c.source_id and s.organization_id = c.organization_id
         where c.organization_id = any($1::text[])
           and s.status = 'active'
           and s.approval_state = 'approved'
           and s.verification_state = 'verified'
           and not coalesce(s.retrieval_suppressed, false)
           and d.ingest_state = 'indexed'
           and d.index_completed_at is not null
           and d.approval_state = 'approved'
           and d.verification_state = 'verified'
           and c.embedding is not null
           and c.embedding_model = $4
           and (
             ($2::text = 'scoped' and c.subject_id is null)
             or ($2::text = 'subject' and (c.subject_id is null or c.subject_id = $3))
           )
         order by s.authority_tier asc, c.created_at asc
         limit 200`,
        [
          libraryRetrievalOrganizationIds(input.organizationId),
          normalized.scope,
          normalized.effectiveSubjectId,
          currentEmbeddingModel,
        ],
      );

      const ranked = candidates
        .map((candidate) => ({
          ...candidate,
          score: Array.isArray(candidate.embedding)
            ? cosineSimilarity(queryEmbedding, candidate.embedding)
            : 0,
        }))
        // Below the floor, "closest" is noise, not relevance: fall back to
        // keywords rather than cite a chunk that merely lost least badly.
        .filter((candidate) => candidate.score >= SEMANTIC_SCORE_FLOOR)
        .sort((a, b) => b.score - a.score || a.authority_tier - b.authority_tier || a.ordinal - b.ordinal)
        .slice(0, limit)
        .map((candidate) => {
          const { embedding, ...result } = candidate;
          void embedding;
          return result;
        });

      if (ranked.length > 0) {
        await writeShadowTelemetryEvent({
          organizationId: input.organizationId,
          metricName: 'shadow.library.search',
          actorAccountId: input.actorAccountId,
          actorRole: input.actorRole,
          dimensions: {
            scope: normalized.scope,
            result_count: ranked.length,
            term_count: terms.length,
            search_mode: 'semantic',
          },
        });
        return ranked;
      }
    }
  }

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
       c.metadata->>'evidence_class' as evidence_class,
       c.metadata->>'boxing_specificity' as boxing_specificity,
       (
          case when lower(c.text_content) like '%' || $4 || '%' then 40 else 0 end
          + case when lower(d.document_name) like '%' || $4 || '%' then 20 else 0 end
          + case when lower(s.title) like '%' || $4 || '%' then 25 else 0 end
          + case when cardinality($5::text[]) > 0 then (
              select count(*)::int * 8
              from unnest($5::text[]) as term
             where lower(c.text_content) like term
                or lower(d.document_name) like term
                or lower(s.title) like term
           ) else 0 end
         + (6 - s.authority_tier) * 3
       )::float as score
     from pilot.shadow_library_chunks c
     join pilot.shadow_library_documents d on d.document_id = c.document_id and d.organization_id = c.organization_id
     join pilot.shadow_library_sources s on s.source_id = c.source_id and s.organization_id = c.organization_id
      where c.organization_id = any($1::text[])
        and s.status = 'active'
        and s.approval_state = 'approved'
        and s.verification_state = 'verified'
        and not coalesce(s.retrieval_suppressed, false)
        and d.ingest_state = 'indexed'
        and d.index_completed_at is not null
        and d.approval_state = 'approved'
        and d.verification_state = 'verified'
        -- Every branch constrains subject_id. There is no scope value that
        -- selects athlete-scoped chunks without naming the subject, so an
        -- unrecognized scope matches nothing rather than matching everything.
         and (
          ($2::text = 'scoped' and c.subject_id is null)
          or ($2::text = 'subject' and (c.subject_id is null or c.subject_id = $3))
        )
        and (
          lower(c.text_content) like '%' || $4 || '%'
          or lower(d.document_name) like '%' || $4 || '%'
          or lower(s.title) like '%' || $4 || '%'
          or exists (
            select 1
            from unnest($5::text[]) as term
           where lower(c.text_content) like term
              or lower(d.document_name) like term
              or lower(s.title) like term
         )
       )
     order by score desc, s.authority_tier asc, c.ordinal asc, c.created_at asc
      limit $6`,
    [
      libraryRetrievalOrganizationIds(input.organizationId),
      normalized.scope,
      normalized.effectiveSubjectId,
      wholeQuery,
      termPatterns,
      limit,
    ],
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
  actorRole: PilotRole;
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
  let status: ShadowLibraryClaimStatus;
  let confidence: number;

  // The canonical-doctrine shortcut that used to sit here required scope
  // 'master', which no caller could produce, so it never fired. It was removed
  // with that scope; dropping it is behavior-preserving.
  if (distinctSourceCount >= 2 && evidence.length >= 2) {
    status = 'supported';
    confidence = 0.78;
  } else if (evidence.length >= 1) {
    status = 'weak';
    confidence = 0.46;
  } else {
    status = 'unsupported';
    confidence = 0.12;
  }

  const claimResearchRequirement = await ensureClaimResearchRequirement({
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
      research_requirement_id: claimResearchRequirement?.id ?? null,
      // Research Intake Cards (getShadowResearchProjection) reads these two
      // keys straight off the event payload -- without them, the card the
      // widened filter above now surfaces would render "Not provided" for
      // both fields instead of the actual gap.
      research_requirement: claimResearchRequirement?.researchRequirement ?? null,
      knowledge_gap: claimResearchRequirement?.knowledgeGap ?? null,
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
    evidenceCount: evidence.length,
    distinctSourceCount,
    evidence,
    researchRequirementId: claimResearchRequirement?.id ?? null,
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

  if (rows.length > 0) {
    const states = rows.map((row) => {
      if (row.matched_sources <= 0) return 'uncovered' as const;
      if (row.matched_sources < row.minimum_source_count) return 'partial' as const;
      return 'covered' as const;
    });

    // One statement for every rule's coverage_state instead of one UPDATE
    // per rule: a curator's taxonomy is typically tens of rules, re-evaluated
    // in full on every recompute call, so this was N round trips for a
    // write that has no per-row failure mode to isolate (unlike, say,
    // rosterImport's per-row create -- every row here is an unconditional
    // update to a row that provably exists, since it came from cm itself).
    await query(
      `update pilot.shadow_library_capability_map as cm
       set coverage_state = v.coverage_state,
           last_evaluated_at = now(),
           updated_at = now()
       from unnest($2::text[], $3::text[]) as v(capability_map_id, coverage_state)
       where cm.organization_id = $1 and cm.capability_map_id = v.capability_map_id`,
      [input.organizationId, rows.map((row) => row.capability_map_id), states],
    );

    // Fetched ONCE for the whole pass -- see ensureCoverageGapResearchRequirement's
    // own comment on why every row in this pass may safely share one snapshot.
    const openItems = await listShadowResearchRequirements(input.organizationId, { status: 'open' });

    for (const [index, row] of rows.entries()) {
      await ensureCoverageGapResearchRequirement({
        organizationId: input.organizationId,
        actorAccountId: input.actorAccountId,
        actorRole: input.actorRole,
        row,
        coverageState: states[index],
        openItems,
      });
    }
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
