import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';

import { assertActorCanAccessAthlete } from './access';
import type { PilotRole } from './contracts';
import { query, queryOne, withTransaction } from './db';
import { athleteNotDeletedSql } from './deletedAthletes';
import { ConflictError, PilotError, ValidationError } from './errors';
import { SERVABLE_GYM_WIDE_LIBRARY_DOCUMENT_SQL, SERVABLE_LIBRARY_SOURCE_SQL } from './libraryServability';
import { libraryRetrievalOrganizationIds } from './platformLibraryScope';
import { cosineSimilarity, embedText, getEmbeddingDeploymentName, isSemanticLibrarySearchEnabled } from './shadowEmbeddings';
import { emitShadowEvent } from './shadowEvents';
import { reservedProvenanceKey, reservedProvenanceMessage, type ShadowLibraryRightsStatus } from './shadowLibraryRights';
import {
  buildCapabilityGapResearchFields,
  CAPABILITY_GAP_SOURCE_ENTITY_TYPE,
  CAPABILITY_GAP_SOURCE_EVENT_NAME,
  createShadowResearchRequirement,
  resolveCoveredCapabilityGapRequirements,
  syncCapabilityGapRequirement,
} from './shadowResearch';
import { writeShadowTelemetryEvent } from './shadowTelemetry';

// Below this cosine similarity, the best semantic match is noise rather than
// relevance, and the search falls back to keywords instead of citing the
// chunk that merely lost least badly. Deliberately permissive: embeddings
// separate related from unrelated text well above this line, and the
// downstream evidence review gates still apply to whatever is returned.
// Exported so pilotOpsReadiness.ts can report the real value.
export const SEMANTIC_SCORE_FLOOR = 0.15;

// RELEVANCE BAR (Jason 2026-10-03: "display confidence level and submit
// research request to fill gap"). Passages at or above the bar are evidence.
// Passages below it are only the "closest" ones: still shown, labelled low
// confidence, and the question is filed as a research requirement. The
// authority-tier bonus the keyword path used to add never counts toward either
// number, so a high-tier source with no real match cannot clear the bar.
//   semantic: cosine similarity. 0.30 / 0.50 are UNCALIBRATED starting values
//             (no labelled queries exist to fit them); tune from real use.
//   keyword:  share of the question's meaningful words found as WHOLE words.
export const SEMANTIC_RELEVANCE_BAR = 0.3;
export const SEMANTIC_HIGH_CONFIDENCE = 0.5;
export const KEYWORD_RELEVANCE_BAR = 0.6;
export const KEYWORD_HIGH_CONFIDENCE = 0.8;

// Semantic search reads every candidate in keyset batches of this many rows
// (CL-C13), so memory holds one batch of vectors at a time, not the Library.
export const SEMANTIC_CANDIDATE_BATCH_SIZE = 500;

function isNumericVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((element) => typeof element === 'number' && Number.isFinite(element));
}

export type ShadowLibraryConfidenceLevel = 'high' | 'medium' | 'low' | 'none';

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
  rights_status: ShadowLibraryRightsStatus;
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
  text_kind: 'full_text' | 'excerpt';
  excerpt_locator: string | null;
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
  // Plain level for display, from the best passage's relevance score on the
  // path that ran (see the RELEVANCE BAR constants): high / medium / low, or
  // 'none' when nothing matched at all. Below-bar "closest passages" are 'low'.
  confidenceLevel: ShadowLibraryConfidenceLevel;
  // Passages at or above the bar. `evidence` may also hold below-bar closest
  // passages when confidenceLevel is 'low'; they are not counted here.
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

/**
 * How many sources can satisfy a capability rule, joined LATERAL against `cm`
 * (pilot.shadow_library_capability_map).
 *
 * Counts only sources a gym-wide ('scoped') searchShadowLibrary can actually
 * serve: approved, verified, not suppressed for retraction, and cited by at
 * least one gym-wide chunk that sits in an indexed, approved, verified document
 * not scoped to one athlete (see libraryServability.ts). It used to count any
 * active source, so a rule read "covered" on a source still waiting for
 * review, never indexed, or pulled for retraction -- while search returned
 * nothing for it -- and because it read covered,
 * ensureCoverageGapResearchRequirement opened no gap ticket.
 *
 * THROUGH THE CHUNKS THAT CITE IT, NOT THE DOCUMENT IT OWNS. Search serves a
 * source by joining each chunk to `s` on the chunk's own source_id and to `d`
 * on the chunk's document_id; nothing in that join asks which source owns the
 * document. The research corpus is built that way: on __platform__ all 14
 * documents belong to one programme source (internal_policy, tier 3), and
 * their 1,173 chunks cite 968 other sources that own no document at all. A
 * count keyed on document ownership therefore saw the programme source and
 * nothing else, while search was serving hundreds of peer-reviewed,
 * governing-body and clinical-guideline sources out of those same documents.
 * The EXISTS below is search's own join: chunk to document on both halves of
 * the key, chunk to source on the chunk's source_id and organization.
 *
 * FROM EXACTLY THE SHELVES SEARCH READS. `$2` is
 * libraryRetrievalOrganizationIds(organizationId) -- the gym's own shelf plus
 * the shared platform baseline (__platform__) -- the same array
 * searchShadowLibrary passes. Counting the gym's shelf alone called a rule
 * uncovered while search was answering it from the platform shelf, and opened
 * a gap ticket for evidence search was already serving the gym (Jason
 * 2026-09-29, R1: count the shared shelf too). The chunk is matched on the
 * SOURCE's organization and the document on the CHUNK's, as search matches
 * them, so a platform source is never paired with a gym chunk or document, or
 * the reverse.
 *
 * A rule is about the gym's doctrine, not one athlete, so an athlete-scoped
 * chunk or document never counts (search's 'scoped' branch requires
 * c.subject_id is null). The platform shelf cannot hold one at all (its CHECK
 * pilot_shadow_library_documents_platform_unscoped_check).
 *
 * One definition for recompute and list, so the state written and the count
 * shown beside it cannot disagree. Both callers bind `$1` to the organization
 * whose rules are read and `$2` to its retrieval organizations.
 */
const SERVABLE_MATCHED_SOURCES_LATERAL = `
     left join lateral (
       select count(distinct s.source_id) as matched_sources
       from pilot.shadow_library_sources s
       where s.organization_id = any($2::text[])
         and ${SERVABLE_LIBRARY_SOURCE_SQL}
         and s.authority_tier <= cm.minimum_authority_tier
         and (
           coalesce(array_length(cm.required_source_types, 1), 0) = 0
           or s.source_type = any(cm.required_source_types)
         )
         and exists (
           select 1
           from pilot.shadow_library_chunks c
           join pilot.shadow_library_documents d
             on d.document_id = c.document_id
            and d.organization_id = c.organization_id
           where c.source_id = s.source_id
             and c.organization_id = s.organization_id
             and c.subject_id is null
             and ${SERVABLE_GYM_WIDE_LIBRARY_DOCUMENT_SQL}
         )
     ) ms on true`;

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

// Words that carry no topic. Without this list "what is the best way to ..."
// matched every chunk containing "the" or "way".
const QUERY_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'was', 'were', 'but', 'not', 'you', 'your', 'can', 'could', 'should',
  'would', 'will', 'shall', 'may', 'might', 'must', 'has', 'have', 'had', 'does', 'did', 'doing',
  'what', 'which', 'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'that', 'this', 'these',
  'those', 'with', 'from', 'into', 'onto', 'about', 'than', 'then', 'them', 'they', 'their', 'there',
  'here', 'any', 'all', 'some', 'out', 'off', 'over', 'under', 'also', 'just', 'very', 'too', 'its',
  'our', 'his', 'her', 'him', 'she', 'been', 'being', 'get', 'got', 'one', 'use', 'used', 'using',
  'say', 'says', 'tell', 'give', 'show', 'need', 'want', 'make', 'know',
  'way', 'ways', 'does', 'much', 'many', 'more', 'most', 'other', 'such', 'only', 'same', 'while',
]);

function tokenizeQuery(queryText: string): string[] {
  const terms = queryText
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((value) => value.trim())
    .filter((value) => value.length >= 3 && !QUERY_STOPWORDS.has(value));
  // Plain plural folding ("drills" finds "drill" and "drills") so whole-word
  // matching does not lose the recall the old substring match had for free.
  const stems = terms.map((term) => (term.length >= 4 && term.endsWith('s') && !term.endsWith('ss') ? term.slice(0, -1) : term));
  return [...new Set(stems)].slice(0, 8);
}

function buildClaimNarrative(results: ShadowLibrarySearchResult[], closestOnly = false): string {
  const topEvidence = results.slice(0, 3);
  const sourceSummary = topEvidence
    .map((item) => `${item.source_title} (tier ${item.authority_tier})`)
    .join('; ');
  const snippetSummary = topEvidence
    .map((item) => item.text_content.trim())
    .join(' ')
    .slice(0, 500);

  const lead = closestOnly ? 'Closest Library passages' : 'Library-backed answer from current SHADOW evidence';
  return `${lead}: ${snippetSummary}${snippetSummary.endsWith('.') ? '' : '.'} Primary sources: ${sourceSummary}.`;
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

  // The open duplicate, found by key in SQL (audit CL-C15). This used to read
  // every open requirement in the organization into memory on every claim.
  const duplicate = await queryOne<{ research_requirement_id: number }>(
    `select research_requirement_id
     from pilot.shadow_research_requirements
     where organization_id = $1
       and source_entity_type = 'shadow_library_claim'
       and status = 'open'
       and metadata->>'question' = $2
       and metadata->>'scope' = $3
       and (metadata->>'subject_id') is not distinct from $4::text
     order by created_at desc
     limit 1`,
    [input.organizationId, input.question, input.scope, input.subjectId],
  );

  if (duplicate) {
    return { id: duplicate.research_requirement_id, researchRequirement, knowledgeGap };
  }

  const id = await createShadowResearchRequirement({
    organizationId: input.organizationId,
    sourceEventName: 'SHADOW_LIBRARY_CLAIM_GAP_DETECTED',
    sourceEntityType: 'shadow_library_claim',
    // Random, not Date.now(): two different questions in one millisecond
    // collided on the unique key and the second merged into the first.
    sourceEntityId: `${input.scope}:${input.subjectId ?? 'global'}:${randomUUID()}`,
    researchRequirement,
    knowledgeGap,
    evidenceLabel: input.subjectId,
    subjectId: input.subjectId,
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

  const fields = buildCapabilityGapResearchFields({
    capabilityKey: input.row.capability_key,
    coverageState: input.coverageState,
    requiredSourceTypes: input.row.required_source_types,
    minimumAuthorityTier: input.row.minimum_authority_tier,
    minimumSourceCount: input.row.minimum_source_count,
    matchedSources: input.row.matched_sources,
  });
  const metadata = {
    capability_key: input.row.capability_key,
    coverage_state: input.coverageState,
    matched_sources: input.row.matched_sources,
    minimum_source_count: input.row.minimum_source_count,
    minimum_authority_tier: input.row.minimum_authority_tier,
    required_source_types: input.row.required_source_types,
  };

  // One statement opens, refreshes or reopens the capability's single ticket;
  // see syncCapabilityGapRequirement for which rows it may touch. It returns
  // null when nothing was written -- the ticket already says exactly this, or
  // a person resolved it and the capability has not been covered since -- and
  // then there is no new gap to record either. Emitting regardless re-recorded
  // the same gap on every recompute.
  const changedId = await syncCapabilityGapRequirement({
    organizationId: input.organizationId,
    capabilityKey: input.row.capability_key,
    researchRequirement: fields.requirement,
    knowledgeGap: fields.knowledgeGap,
    sourceStatus: fields.sourceStatus,
    createdByAccountId: input.actorAccountId,
    createdByRole: input.actorRole,
    metadata,
  });

  if (changedId === null) {
    return;
  }

  await emitShadowEvent({
    organizationId: input.organizationId,
    eventName: CAPABILITY_GAP_SOURCE_EVENT_NAME,
    entityType: CAPABILITY_GAP_SOURCE_ENTITY_TYPE,
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

// Importer-only provenance (shadowLibraryRights.ts). Held here as well as in the
// routes, so a server caller that skips the route is refused too.
function assertNoReservedProvenance(metadata: Record<string, unknown> | undefined): void {
  const key = reservedProvenanceKey(metadata);
  if (key) throw new ValidationError(reservedProvenanceMessage(key));
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
  rightsStatus?: ShadowLibraryRightsStatus;
  metadata?: Record<string, unknown>;
}): Promise<ShadowLibrarySourceRow> {
  // Marking a source as PPBF-owned or open-licence decides what the Library may
  // hold of it, so it is the reviewer tier's call, as on the rights PATCH.
  if (input.rightsStatus && input.rightsStatus !== 'unknown') requireEvidenceReviewer(input.actorRole as PilotRole);
  assertNoReservedProvenance(input.metadata);
  const sourceId = `source_${randomUUID()}`;

  const row = await queryOne<ShadowLibrarySourceRow>(
    `insert into pilot.shadow_library_sources
      (source_id, organization_id, title, publisher, source_type, authority_tier, url, publication_date, status, metadata, created_by_account_id, created_by_role, rights_status)
     values ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10::jsonb,$11,$12,$13)
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
      input.rightsStatus ?? 'unknown',
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
      rights_status: row.rights_status,
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

/**
 * Narrow rights update: the one marker, nothing else about the source. The
 * reviewer tier decides it, as it decides what becomes citable. Lowering a
 * source that holds full text is refused by the database (the message is
 * rightsRefusalMessage's).
 */
export async function updateShadowLibrarySourceRights(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: PilotRole;
  sourceId: string;
  rightsStatus: ShadowLibraryRightsStatus;
}): Promise<ShadowLibrarySourceRow | null> {
  requireEvidenceReviewer(input.actorRole);
  const row = await withTransaction(async (client) => {
    // The row is locked before it is read, so the recorded "before" is the
    // value this update replaced, even when two reviewers race, and no chunk
    // write (which takes the same lock) can land between the budget count
    // below and the update.
    const before = await client.query<{ rights_status: ShadowLibraryRightsStatus }>(
      `select rights_status from pilot.shadow_library_sources
        where organization_id = $1 and source_id = $2
        for update`,
      [input.organizationId, input.sourceId],
    );
    if (!before.rows[0]) return null;
    // Marking a source down to excerpts-only must not leave it holding more
    // than the excerpt budget allows: otherwise a whole paper loaded while the
    // source read ppbf_owned stays in the Library after it is lowered (CL-C2).
    if (!FULL_TEXT_RIGHTS.includes(input.rightsStatus) && FULL_TEXT_RIGHTS.includes(before.rows[0].rights_status)) {
      const held = await heldExcerptBudget(client, input.sourceId, input.organizationId);
      if (
        held.chunkCount > MAX_EXCERPT_CHUNKS_PER_NON_OWNED_SOURCE
        || held.characterCount > MAX_EXCERPT_CHARACTERS_PER_NON_OWNED_SOURCE
      ) {
        throw new PilotError(
          422,
          `This source holds ${held.chunkCount} passages and ${held.characterCount.toLocaleString('en-US')} characters, more than a source that is not PPBF-owned or open-licence may hold (${excerptBudgetSentence()}). Remove passages first, or keep its rights as they are.`,
          EXCERPT_BUDGET_EXCEEDED_CODE,
        );
      }
    }
    const updated = await client.query<ShadowLibrarySourceRow & { rights_status_before: ShadowLibraryRightsStatus }>(
      `update pilot.shadow_library_sources
          set rights_status = $3, updated_at = now()
        where organization_id = $1 and source_id = $2
       returning *, $4::text as rights_status_before`,
      [input.organizationId, input.sourceId, input.rightsStatus, before.rows[0].rights_status],
    );
    return updated.rows[0] ?? null;
  });
  if (!row) return null;
  const { rights_status_before: rightsBefore, ...source } = row;
  if (rightsBefore === source.rights_status) return source;
  await emitShadowEvent({
    organizationId: input.organizationId,
    eventName: 'SHADOW_LIBRARY_SOURCE_RIGHTS_SET',
    entityType: 'shadow_library_source',
    entityId: row.source_id,
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    payload: { rights_status_before: rightsBefore, rights_status: source.rights_status },
  });
  return source;
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

// Rights statuses whose text may leave the database for the research bridge.
export const RESEARCH_BRIDGE_EXPORTABLE_RIGHTS: readonly ShadowLibraryRightsStatus[] = ['ppbf_owned', 'open_licence'];

// Dedicated export boundary for the read-only research bridge. It deliberately
// excludes subject-scoped chunks, all observational/self-report source types and
// every source not PPBF-owned or open-licence, then reapplies the same source +
// document approval gate used by Library search.
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
     -- The source whose document the text was cut from. A chunk may cite a
     -- different source; the text's rights are its document's, which is what
     -- the database's own full-text guard reads too.
     join pilot.shadow_library_sources ds
       on ds.source_id = d.source_id
     where c.organization_id = $1
       and c.subject_id is null
       and d.subject_id is null
       and s.status = 'active'
       and s.approval_state = 'approved'
       and s.verification_state = 'verified'
       -- A source pulled for retraction keeps its approval (suppressSource
       -- flips only this flag), so without this line the export went on
       -- shipping its text as approved evidence after search had dropped it.
       and not coalesce(s.retrieval_suppressed, false)
       and d.ingest_state = 'indexed'
       and d.index_completed_at is not null
       and d.approval_state = 'approved'
       and d.verification_state = 'verified'
       and s.source_type = any($2::text[])
       -- Licensed excerpts live in the database only (OD-2026-10-02-013
       -- answer 2A); only text the gym may hold in full -- PPBF-owned or
       -- open-licence (answer 4A, shadowLibraryRights.ts) -- may leave it.
       and s.rights_status = any($4::text[])
       and ds.rights_status = any($4::text[])
     order by s.authority_tier asc, s.title asc, c.ordinal asc
     limit $3`,
    [input.organizationId, allowedSourceTypes, limit, RESEARCH_BRIDGE_EXPORTABLE_RIGHTS],
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
         -- A document filed against an athlete leaves the curator queue when
         -- that athlete is deleted (deletion scope B, "10 C"); gym-wide
         -- documents (subject_id null) are untouched.
         and ${athleteNotDeletedSql('d', 'subject_id')}
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
  assertNoReservedProvenance(input.metadata);
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

// EXCERPT BUDGET (CL-C2; OD-2026-10-02-013 answer 4A: "only excerpts a curator
// chooses"). The rights trigger checks that each excerpt names where it comes
// from, but a locator is a label, not a limit: a whole licensed paper loaded as
// consecutive "p. 1", "p. 2" ... excerpts passes it. So a source that is not
// ppbf_owned or open_licence may hold at most this many chunks and this many
// characters in total, across all its documents.
//
// NUMBERS SET BY JASON, 2026-10-07, on Claude's recommendation ("C ... 10
// passages / 15,000 characters per source ... ChatGPT reviews it later"); his
// answer: "double your recomendation", read by overwatch as "do your
// recommendation". This amends OD-2026-10-05-024 item 7 for now. ChatGPT
// reviews the numbers later; raising them is a one-line change here.
export const MAX_EXCERPT_CHUNKS_PER_NON_OWNED_SOURCE = 10;
export const MAX_EXCERPT_CHARACTERS_PER_NON_OWNED_SOURCE = 15_000;

export const EXCERPT_BUDGET_EXCEEDED_CODE = 'SHADOW_LIBRARY_EXCERPT_BUDGET_EXCEEDED';

const FULL_TEXT_RIGHTS: readonly ShadowLibraryRightsStatus[] = ['ppbf_owned', 'open_licence'];

/** Whether a source with these rights is held to the excerpt budget. */
export function isExcerptBudgeted(rightsStatus: string): boolean {
  return !(FULL_TEXT_RIGHTS as readonly string[]).includes(rightsStatus);
}

/**
 * What a source holds ($1 source_id, $2 organization_id), counted by the
 * DOCUMENT's source -- the one whose rights the database rule applies. A chunk
 * may cite another paper in its own source_id (the seed's synthesis pattern),
 * and that must not spend the cited paper's budget. Exported so the licensed
 * excerpt loader's plan counts exactly what this function will.
 */
export const HELD_EXCERPT_BUDGET_SQL = `select count(*)::int as chunk_count,
            coalesce(sum(char_length(c.text_content)), 0)::int as character_count
       from pilot.shadow_library_chunks c
       join pilot.shadow_library_documents d
         on d.document_id = c.document_id and d.organization_id = c.organization_id
      where d.source_id = $1 and d.organization_id = $2`;

function excerptBudgetSentence(): string {
  return `at most ${MAX_EXCERPT_CHUNKS_PER_NON_OWNED_SOURCE} excerpts and ${MAX_EXCERPT_CHARACTERS_PER_NON_OWNED_SOURCE.toLocaleString('en-US')} characters in all`;
}

async function heldExcerptBudget(
  client: PoolClient,
  sourceId: string,
  organizationId: string,
): Promise<{ chunkCount: number; characterCount: number }> {
  const held = await client.query<{ chunk_count: number; character_count: number }>(
    HELD_EXCERPT_BUDGET_SQL,
    [sourceId, organizationId],
  );
  return {
    chunkCount: held.rows[0]?.chunk_count ?? 0,
    characterCount: held.rows[0]?.character_count ?? 0,
  };
}

export async function createShadowLibraryChunk(input: {
  organizationId: string;
  actorAccountId: string;
  actorRole: string;
  documentId: string;
  ordinal: number;
  textContent: string;
  /** Where in the source this text is (page, section or timestamp). Given: an excerpt. Absent: full text. */
  excerptLocator?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<ShadowLibraryChunkRow> {
  const excerptLocator = input.excerptLocator?.trim() || null;
  const chunkId = `chunk_${randomUUID()}`;

  // The document goes back to review and the chunk is written in ONE
  // transaction, the reset first. Search serves a chunk only under an
  // approved, indexed document, so no reader ever sees the new text under the
  // approval of the text a reviewer saw before it (CL-C3). These used to be
  // separate statements with the embedding call between them: the chunk was
  // live under the approved document for that whole network round trip, and
  // for good if the process died inside it.
  const row = await withTransaction(async (client) => {
    // The document's source row is locked first, so two writers to the same
    // source take turns at the excerpt budget below: each counts what the
    // other committed, and they cannot both pass it and together exceed it.
    // Source before document is the order the research importer takes them
    // in, so the two cannot deadlock. NO KEY UPDATE, not UPDATE, so creating
    // a document or chunk that merely references this source is not blocked.
    const locked = await client.query<{ source_id: string; rights_status: ShadowLibraryRightsStatus }>(
      `select s.source_id, s.rights_status
         from pilot.shadow_library_sources s
        where s.organization_id = $2
          and s.source_id = (
            select d.source_id from pilot.shadow_library_documents d
             where d.document_id = $1 and d.organization_id = $2
          )
        for no key update of s`,
      [input.documentId, input.organizationId],
    );
    const source = locked.rows[0];
    if (!source) {
      throw new Error('Document does not exist in this organization.');
    }

    const reset = await client.query<{ document_id: string; source_id: string; subject_id: string | null }>(
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
       where document_id = $1 and organization_id = $2 and source_id = $3
       returning document_id, source_id, subject_id`,
      [input.documentId, input.organizationId, source.source_id],
    );
    const document = reset.rows[0];
    if (!document) {
      // Moved to another source between the lock and the reset.
      throw new ConflictError('This document moved to another source while the text was being saved. Try again.');
    }

    if (!FULL_TEXT_RIGHTS.includes(source.rights_status)) {
      const { chunkCount, characterCount } = await heldExcerptBudget(client, document.source_id, input.organizationId);
      const newCharacters = Array.from(input.textContent.trim()).length;
      if (
        chunkCount + 1 > MAX_EXCERPT_CHUNKS_PER_NON_OWNED_SOURCE
        || characterCount + newCharacters > MAX_EXCERPT_CHARACTERS_PER_NON_OWNED_SOURCE
      ) {
        throw new PilotError(
          422,
          `This source is not marked PPBF-owned or open-licence, so the Library may hold only a limited set of excerpts of it: ${excerptBudgetSentence()}. It holds ${chunkCount} excerpts and ${characterCount.toLocaleString('en-US')} characters; this one adds ${newCharacters.toLocaleString('en-US')}.`,
          EXCERPT_BUDGET_EXCEEDED_CODE,
        );
      }
    }

    const inserted = await client.query<ShadowLibraryChunkRow>(
      `insert into pilot.shadow_library_chunks
        (chunk_id, document_id, source_id, organization_id, subject_id, ordinal, text_content, metadata, created_by_account_id, created_by_role, text_kind, excerpt_locator)
       values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)
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
        excerptLocator ? 'excerpt' : 'full_text',
        excerptLocator,
      ],
    );
    if (!inserted.rows[0]) {
      throw new Error('Unable to create SHADOW Library chunk.');
    }
    return inserted.rows[0];
  });

  // Best-effort embedding, after the commit: when the embedding deployment is
  // configured, the chunk becomes semantically searchable once its document is
  // approved again. A failed or disabled embedding leaves the column NULL and
  // the chunk still fully usable through keyword search; the backfill script
  // picks up NULLs later. Never lets an embedding problem fail the
  // registration the curator just performed.
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

/**
 * A document entered through manual text intake (/research, Add Source Text)
 * declares in metadata.chunk_count how many parts its text was split into, and
 * its parts are written one request at a time. If a later part fails and the
 * curator's page is gone, the document is left holding the first few parts of
 * an excerpt -- and "at least one non-empty chunk" would let a reviewer index
 * and approve it, after which SHADOW cites a truncated excerpt as the whole.
 *
 * So for those documents, and only those, indexing also requires that the
 * stored parts are exactly the declared ones: the declared number of them,
 * ordinals 0..n-1 (unique (document_id, ordinal) makes count + min + max
 * sufficient). A manual-text document with a missing or malformed chunk_count
 * fails closed. Every other document -- the imported corpus, the doctrine seed
 * -- carries no intake_method and is untouched by this predicate.
 *
 * Written against alias d = pilot.shadow_library_documents.
 *
 * Exported for one reason: scripts/pilot-approve-library-baseline.mjs indexes
 * documents with its own SQL and carries a copy of this text (a plain .mjs
 * cannot import this module). shadowLibraryPipeline.pg.test.ts compares the two.
 */
export const MANUAL_TEXT_INTAKE_COMPLETE_SQL = `(
  d.metadata->>'intake_method' is distinct from 'manual_text'
  or case
    when d.metadata->>'chunk_count' ~ '^[1-9][0-9]{0,5}$' then (
      select count(*) = (d.metadata->>'chunk_count')::int
         and min(c.ordinal) = 0
         and max(c.ordinal) = (d.metadata->>'chunk_count')::int - 1
      from pilot.shadow_library_chunks c
      where c.document_id = d.document_id
        and c.organization_id = d.organization_id
    )
    else false
  end
)`;

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
       and ${MANUAL_TEXT_INTAKE_COMPLETE_SQL}
     returning d.*`,
    [input.documentId, input.organizationId],
  );
  if (!row) {
    // The update says only that it matched nothing. Ask why, so a reviewer
    // facing a half-saved excerpt is told that, and how many parts are there.
    const partial = await queryOne<{ declared: string | null; stored: string }>(
      `select d.metadata->>'chunk_count' as declared,
              (select count(*) from pilot.shadow_library_chunks c
                where c.document_id = d.document_id
                  and c.organization_id = d.organization_id)::text as stored
       from pilot.shadow_library_documents d
       where d.document_id = $1
         and d.organization_id = $2
         and d.metadata->>'intake_method' = 'manual_text'
         and not ${MANUAL_TEXT_INTAKE_COMPLETE_SQL}`,
      [input.documentId, input.organizationId],
    );
    if (partial) {
      throw new ConflictError(
        `This excerpt is incomplete: ${partial.stored} of ${partial.declared ?? 'an unrecorded number of'} parts are stored. `
        + 'It cannot be indexed or approved. Reject it, and have the text entered again from Research.',
        'SHADOW_LIBRARY_DOCUMENT_INCOMPLETE',
      );
    }
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
export interface ShadowLibrarySearchInput {
  organizationId: string;
  actorAccountId: string;
  actorRole: PilotRole;
  athleteId?: string | null;
  scope?: ShadowLibraryScope;
  subjectId?: string | null;
  queryText: string;
  limit?: number;
}

/**
 * Optional second argument to searchShadowLibrary. Pass an object and the
 * search fills it in; the return value is unchanged.
 */
export interface ShadowLibrarySearchDetail {
  // Matched something but below the relevance bar: the closest passages,
  // never evidence. The return value holds only passages at or above the bar.
  nearest: ShadowLibrarySearchResult[];
  // Which path ranked them, which decides how a score maps to a confidence level.
  mode: 'semantic' | 'keyword';
}

/** Plain confidence level for one passage's score (0-1) on the given path. */
export function confidenceLevelForScore(mode: 'semantic' | 'keyword', score: number): ShadowLibraryConfidenceLevel {
  const [bar, high] = mode === 'semantic'
    ? [SEMANTIC_RELEVANCE_BAR, SEMANTIC_HIGH_CONFIDENCE]
    : [KEYWORD_RELEVANCE_BAR, KEYWORD_HIGH_CONFIDENCE];
  if (score >= high) return 'high';
  if (score >= bar) return 'medium';
  return 'low';
}

// Returns evidence only: passages at or above the relevance bar. The search
// keeps one body (and so one retrieval-organization predicate) on purpose:
// platformLibraryWriteScope.convention.test.ts reads this function to prove it
// still admits the platform baseline.
export async function searchShadowLibrary(
  input: ShadowLibrarySearchInput,
  detail?: ShadowLibrarySearchDetail,
): Promise<ShadowLibrarySearchResult[]> {
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

  if (normalized.scope === 'subject' && normalized.effectiveSubjectId) {
    await assertActorCanAccessAthlete({
      accountId: input.actorAccountId,
      organizationId: input.organizationId,
      role: input.actorRole,
      athleteId: input.athleteId ?? null,
    }, normalized.effectiveSubjectId);
  }

  // Semantic path, when the embedding deployment is live: rank EVERY candidate
  // (same approval/verification/scope filters as the keyword query, restricted
  // to chunks that HAVE an embedding) by cosine similarity computed
  // in-process. It used to load at most 200 candidates ordered by tier and
  // age and rank only those, so past 200 embedded chunks the best match could
  // sit outside the window and never be found (CL-C13). Now every candidate
  // is read, in keyset batches so memory holds one batch at a time, and only
  // the running top `limit` is kept. Scoring stays in the application because
  // Postgres arithmetic over jsonb measured about ten times slower than
  // reading the vectors out (pgvector is not enabled on the managed server;
  // enabling it is the path if the Library outgrows this). The keyword path
  // below remains byte-for-byte the shipped behavior whenever semantics is
  // disabled, errors, or finds nothing relevant -- an embedding outage
  // degrades search, never breaks it.
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
      let candidateCount = 0;
      let afterChunkId = '';
      let ranked: ShadowLibrarySearchResult[] = [];
      for (;;) {
        const batch = await query<ShadowLibrarySearchResult & { embedding: unknown }>(
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
             and c.chunk_id > $5
           order by c.chunk_id asc
           limit $6`,
          [
            libraryRetrievalOrganizationIds(input.organizationId),
            normalized.scope,
            normalized.effectiveSubjectId,
            currentEmbeddingModel,
            afterChunkId,
            SEMANTIC_CANDIDATE_BATCH_SIZE,
          ],
        );
        candidateCount += batch.length;
        const scored = batch
          .map(({ embedding, ...candidate }) => ({
            ...candidate,
            // An embedding that is not an array of finite numbers scores 0
            // and drops below the floor: one bad row never fails search, and
            // a string "1" is not read as the number 1.
            score: isNumericVector(embedding) ? cosineSimilarity(queryEmbedding, embedding) : 0,
          }))
          // Below the floor, "closest" is noise, not relevance. It is dropped,
          // and it does NOT fall back to loose keywords: that fallback is how a
          // nonsense question used to get an unrelated passage.
          .filter((candidate) => candidate.score >= SEMANTIC_SCORE_FLOOR);
        ranked = [...ranked, ...scored]
          // chunk_id last, so the order does not depend on which batch a tie arrived in.
          .sort((a, b) => b.score - a.score || a.authority_tier - b.authority_tier || a.ordinal - b.ordinal
            || (a.chunk_id < b.chunk_id ? -1 : a.chunk_id > b.chunk_id ? 1 : 0))
          .slice(0, limit);
        if (batch.length < SEMANTIC_CANDIDATE_BATCH_SIZE) break;
        afterChunkId = batch[batch.length - 1].chunk_id;
      }

      // Candidates exist (embedded chunks are in the library), so this answer
      // is final even when empty. Only "no embedded chunks yet" or an embedding
      // outage degrades to the keyword path below.
      if (candidateCount > 0) {
        const relevant = ranked.filter((item) => item.score >= SEMANTIC_RELEVANCE_BAR);
        const nearest = ranked.filter((item) => item.score < SEMANTIC_RELEVANCE_BAR);
        await writeShadowTelemetryEvent({
          organizationId: input.organizationId,
          metricName: 'shadow.library.search',
          actorAccountId: input.actorAccountId,
          actorRole: input.actorRole,
          dimensions: {
            scope: normalized.scope,
            result_count: relevant.length,
            nearest_count: nearest.length,
            term_count: terms.length,
            search_mode: 'semantic',
          },
        });
        if (detail) {
          detail.nearest = nearest;
          detail.mode = 'semantic';
        }
        return relevant;
      }
    }
  }

  // Keyword path. Whole words only (so "art" no longer matches "party"), stop
  // words already dropped, and the score is the share of the question's words
  // found -- the authority tier is a tie-break, never a score. No meaningful
  // word left means there is nothing to match on.
  const rows = terms.length === 0 ? [] : await query<ShadowLibrarySearchResult>(
    `select * from (
       select
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
           select count(*)::float / cardinality($4::text[])
             from unnest($4::text[]) as term
            where lower(coalesce(c.text_content, '') || ' ' || coalesce(d.document_name, '') || ' ' || coalesce(s.title, '')) ~ ('\\m' || term || '(s|es)?\\M')
         ) as score
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
     ) ranked
     where score > 0
     order by score desc, authority_tier asc, ordinal asc, chunk_id asc
     limit $5`,
    [
      libraryRetrievalOrganizationIds(input.organizationId),
      normalized.scope,
      normalized.effectiveSubjectId,
      terms,
      limit,
    ],
  );

  const relevant = rows.filter((row) => row.score >= KEYWORD_RELEVANCE_BAR);
  const nearest = rows.filter((row) => row.score < KEYWORD_RELEVANCE_BAR);

  await writeShadowTelemetryEvent({
    organizationId: input.organizationId,
    metricName: 'shadow.library.search',
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    dimensions: {
      scope: normalized.scope,
      result_count: relevant.length,
      nearest_count: nearest.length,
      subject_scoped: Boolean(normalized.effectiveSubjectId),
    },
  });

  if (detail) {
    detail.nearest = nearest;
    detail.mode = 'keyword';
  }
  return relevant;
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

  const detail: ShadowLibrarySearchDetail = { nearest: [], mode: 'keyword' };
  const relevantEvidence = await searchShadowLibrary({
    organizationId: input.organizationId,
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    athleteId: input.athleteId,
    scope: normalized.scope,
    subjectId: normalized.effectiveSubjectId,
    queryText: input.question,
    limit: input.limit ?? 5,
  }, detail);
  const ranked = { relevant: relevantEvidence, nearest: detail.nearest, mode: detail.mode };

  // Above the relevance bar = evidence. Below it, the closest passages are
  // still shown (low confidence) but never count as evidence and never make
  // the claim 'supported'; the gap is filed as a research requirement.
  const belowBarOnly = ranked.relevant.length === 0 && ranked.nearest.length > 0;
  const evidence = belowBarOnly ? ranked.nearest : ranked.relevant;
  const counted = ranked.relevant;

  const distinctSourceCount = new Set(counted.map((item) => item.source_id)).size;
  let status: ShadowLibraryClaimStatus;
  let confidence: number;
  let confidenceLevel: ShadowLibraryConfidenceLevel;

  // The canonical-doctrine shortcut that used to sit here required scope
  // 'master', which no caller could produce, so it never fired. It was removed
  // with that scope; dropping it is behavior-preserving.
  const bestScore = counted.reduce((max, item) => Math.max(max, item.score), 0);
  const bestLevel = confidenceLevelForScore(ranked.mode, bestScore);
  if (distinctSourceCount >= 2 && counted.length >= 2) {
    status = 'supported';
    confidence = 0.78;
    confidenceLevel = bestLevel;
  } else if (counted.length >= 1) {
    status = 'weak';
    confidence = 0.46;
    // One source cannot carry a claim past medium.
    confidenceLevel = bestLevel === 'high' ? 'medium' : bestLevel;
  } else if (belowBarOnly) {
    status = 'weak';
    confidence = 0.25;
    confidenceLevel = 'low';
  } else {
    status = 'unsupported';
    confidence = 0.12;
    confidenceLevel = 'none';
  }

  const claimResearchRequirement = await ensureClaimResearchRequirement({
    organizationId: input.organizationId,
    actorAccountId: input.actorAccountId,
    actorRole: input.actorRole,
    scope: normalized.scope,
    subjectId: normalized.effectiveSubjectId,
    question: input.question.trim(),
    status,
    evidenceCount: counted.length,
    distinctSourceCount,
  });

  const answer =
    status === 'unsupported'
      ? 'SHADOW Library does not currently have qualifying evidence for this question. A research requirement has been opened or matched so the gap becomes organizational learning work.'
      : belowBarOnly
        ? `Confidence: low. The Library has no passage that clearly answers this question; these are the closest passages and may not be relevant. A research requirement has been opened or matched to fill the gap. ${buildClaimNarrative(evidence, true)}`
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
      evidence_count: counted.length,
      confidence_level: confidenceLevel,
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
      confidence_level: confidenceLevel,
      evidence_count: counted.length,
      distinct_source_count: distinctSourceCount,
    },
  });

  return {
    answer,
    status,
    confidence,
    confidenceLevel,
    evidenceCount: counted.length,
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
     ${SERVABLE_MATCHED_SOURCES_LATERAL}
     where cm.organization_id = $1`,
    [input.organizationId, libraryRetrievalOrganizationIds(input.organizationId)],
  );

  let closedGapRequirements: Array<{ research_requirement_id: number; capability_key: string }> = [];

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

    for (const [index, row] of rows.entries()) {
      await ensureCoverageGapResearchRequirement({
        organizationId: input.organizationId,
        actorAccountId: input.actorAccountId,
        actorRole: input.actorRole,
        row,
        coverageState: states[index],
      });
    }

    // The other half of the gap ticket's life (Jason 2026-09-29, R2): a rule
    // that grades covered closes its own open gap ticket. Before this the
    // ticket stayed open after the evidence arrived, and it went on feeding the
    // triage view and the research bridge export as work still to do.
    closedGapRequirements = await resolveCoveredCapabilityGapRequirements({
      organizationId: input.organizationId,
      covered: rows
        .filter((_, index) => states[index] === 'covered')
        .map((row) => ({ capabilityKey: row.capability_key, matchedSources: row.matched_sources })),
      resolvedByAccountId: input.actorAccountId,
      resolvedByRole: input.actorRole,
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
      // Which gap tickets this pass closed, on the event that already records
      // who ran it. The rows themselves carry the same attribution.
      closed_research_requirement_ids: closedGapRequirements.map((row) => row.research_requirement_id),
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
     ${SERVABLE_MATCHED_SOURCES_LATERAL}
     where cm.organization_id = $1
     order by cm.capability_key asc`,
    [organizationId, libraryRetrievalOrganizationIds(organizationId)],
  );
}
