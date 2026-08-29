import { createHash } from 'node:crypto';

import {
  listApprovedGlobalEvidenceForResearchBridge,
  type ShadowApprovedEvidenceExportRow,
} from './shadowLibrary';
import {
  listShadowResearchRequirements,
  subjectAthleteIdOf,
  type ShadowResearchRequirementRow,
} from './shadowResearch';

export interface SanitizedResearchNeed {
  id: string;
  title: string;
  knowledge_gap: string;
  evidence_status: string;
  confidence_tier: string;
  verification_state: string;
  status: 'open' | 'resolved';
  created_at: string;
}

export interface SanitizedApprovedEvidence {
  id: string;
  title: string;
  publisher: string | null;
  source_type: 'peer_reviewed' | 'clinical_guideline' | 'governing_body' | 'textbook';
  authority_tier: number;
  url: string | null;
  publication_date: string | null;
  excerpt: string;
}

const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const US_PHONE = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const SECRET_ASSIGNMENT = /\b(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*[^\s,;]+/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;

export function redactResearchText(value: string, maxLength = 4_000): string {
  return value
    .replace(BEARER, '[REDACTED_TOKEN]')
    .replace(EMAIL, '[REDACTED_EMAIL]')
    .replace(US_PHONE, '[REDACTED_PHONE]')
    .replace(SSN, '[REDACTED_SSN]')
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function opaqueId(prefix: 'need' | 'evidence', organizationId: string, internalId: string): string {
  const digest = createHash('sha256')
    .update(`${organizationId}:${internalId}`)
    .digest('hex')
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

/**
 * The person-naming metadata keys this filter has always refused, kept
 * alongside the canonical subject resolution rather than replaced by it.
 *
 * subject_id and athlete_id overlap with what subjectAthleteIdOf reads;
 * account_id, parent_id and guardian_id do not -- they name an account or a
 * guardian rather than the athlete a row is ABOUT, so the canonical resolver
 * has no opinion on them and correctly returns null. They still must not
 * leave the platform, so both checks run and a row is excluded if either
 * finds somebody.
 */
function hasSubjectLink(metadata: Record<string, unknown>): boolean {
  return ['subject_id', 'athlete_id', 'account_id', 'parent_id', 'guardian_id']
    .some((key) => typeof metadata[key] === 'string' && Boolean((metadata[key] as string).trim()));
}

/**
 * Is this requirement about NO child, and therefore exportable?
 *
 * WHICH ATHLETE A ROW NAMES is shadowResearch's question, and
 * subjectAthleteIdOf is its answer: the dedicated subject_id COLUMN first,
 * then the metadata fallbacks, in the priority order every other reader uses
 * (shadowResearch.ts -- "subject_id is the authority"). This filter used to
 * ask a private metadata-only helper instead, so the column that
 * pilot_slice_postgres_research_requirement_subject_migration.sql added
 * precisely to record "which child is this row about" was selected, carried on
 * the row, and never read here.
 *
 * The gap was reachable, not theoretical. POST
 * /api/pilot/shadow/research-requirements passes source_entity_type straight
 * from the request body, so a row written with subject_id set, metadata {} and
 * an allowlisted source_entity_type read as subject-less and was exported --
 * a research requirement about one named child, with its free-text
 * research_requirement and knowledge_gap, leaving the platform through a
 * payload whose whole claim is that it carries none.
 *
 * Deliberately additive: the metadata keys hasSubjectLink already refused are
 * still refused, so this widens what is excluded and narrows nothing.
 */
function isEligibleResearchNeed(row: ShadowResearchRequirementRow): boolean {
  const metadata = row.metadata ?? {};
  if (subjectAthleteIdOf(row) !== null || hasSubjectLink(metadata)) {
    return false;
  }
  if (row.source_entity_type === 'shadow_library_capability_map') {
    return true;
  }
  return row.source_entity_type === 'shadow_library_claim'
    && metadata.scope === 'scoped'
    && (metadata.subject_id === null || metadata.subject_id === undefined || metadata.subject_id === '');
}

export function sanitizeResearchNeeds(rows: ShadowResearchRequirementRow[]): SanitizedResearchNeed[] {
  return rows
    .filter(isEligibleResearchNeed)
    .map((row) => ({
      id: opaqueId('need', row.organization_id, String(row.research_requirement_id)),
      title: redactResearchText(row.research_requirement, 500),
      knowledge_gap: redactResearchText(row.knowledge_gap),
      evidence_status: row.source_status,
      confidence_tier: row.source_confidence_tier,
      verification_state: row.source_verification_state,
      status: row.status,
      created_at: row.created_at,
    }))
    .filter((row) => row.title.length > 0 && row.knowledge_gap.length > 0);
}

function safePublicUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export function sanitizeApprovedEvidence(
  organizationId: string,
  rows: ShadowApprovedEvidenceExportRow[],
): SanitizedApprovedEvidence[] {
  return rows
    .map((row) => ({
      id: opaqueId('evidence', organizationId, row.chunk_id),
      title: redactResearchText(row.source_title, 500),
      publisher: row.source_publisher ? redactResearchText(row.source_publisher, 500) : null,
      source_type: row.source_type,
      authority_tier: Math.max(1, Math.min(5, Math.trunc(row.authority_tier))),
      url: safePublicUrl(row.source_url),
      publication_date: row.publication_date,
      excerpt: redactResearchText(row.text_content),
    }))
    .filter((row) => row.title.length > 0 && row.excerpt.length > 0);
}

export async function buildResearchBridgeExport(organizationId: string) {
  const [researchNeeds, approvedEvidence] = await Promise.all([
    listShadowResearchRequirements(organizationId),
    listApprovedGlobalEvidenceForResearchBridge({ organizationId, limit: 2_000 }),
  ]);

  return {
    schema_version: '1' as const,
    classification: 'sanitized-staging-only' as const,
    generated_at: new Date().toISOString(),
    research_needs: sanitizeResearchNeeds(researchNeeds),
    approved_evidence: sanitizeApprovedEvidence(organizationId, approvedEvidence),
  };
}
