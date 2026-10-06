import { createHash } from 'node:crypto';

import {
  listApprovedGlobalEvidenceForResearchBridge,
  listShadowCapabilityCoverage,
  type ShadowApprovedEvidenceExportRow,
  type ShadowCapabilityCoverageRow,
  type ShadowLibrarySourceType,
} from './shadowLibrary';
import {
  buildCapabilityGapResearchFields,
  CAPABILITY_GAP_SOURCE_ENTITY_TYPE,
  CAPABILITY_GAP_SOURCE_EVENT_NAME,
  listShadowResearchRequirements,
  subjectAthleteIdOf,
  type CapabilityGapFields,
  type ShadowResearchRequirementRow,
} from './shadowResearch';

// The research bridge's own limits (apps/research-bridge/src/schemas.ts). An
// export past any of them is rejected whole, and a rejected export never
// reaches the bridge's delete step -- so evidence withdrawn here would stay
// served there. The export keeps inside them instead.
export const RESEARCH_BRIDGE_MAX_NEEDS = 500;
export const RESEARCH_BRIDGE_MAX_EVIDENCE = 2_000;
export const RESEARCH_BRIDGE_MAX_URL_LENGTH = 2_000;

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

// A capability key is a curator's identifier (motor_learning_practice_design),
// never prose.
const CAPABILITY_KEY = /^[a-z0-9][a-z0-9_.-]{0,119}$/;
const KNOWN_SOURCE_TYPES: readonly ShadowLibrarySourceType[] = [
  'peer_reviewed', 'clinical_guideline', 'governing_body', 'coach_observation', 'athlete_self_report',
  'sensor_data', 'internal_policy', 'textbook', 'media', 'other',
];

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * The capability rule a gap ticket stands for, or null when the row is not a
 * gap ticket for a rule the gym actually has.
 *
 * WHO WROTE A ROW cannot be read from it: the coverage check stores the role
 * of whoever triggered the recompute; POST
 * /api/pilot/shadow/research-requirements let any member choose the event
 * name, entity type and metadata until it refused the reserved kinds; and its
 * resolve action still merges caller metadata into any row it may resolve. So
 * the export trusts nothing a row stores but the capability key it names. The
 * rule -- required source types, minimums, coverage, matched count -- comes
 * from pilot.shadow_library_capability_map, which only curators write, and the
 * text is rebuilt from it. A row naming a key the gym has no rule for (a forged
 * row, a rule since deleted) is not exported.
 */
function capabilityGapFieldsOf(
  row: ShadowResearchRequirementRow,
  rules: ReadonlyMap<string, ShadowCapabilityCoverageRow>,
): CapabilityGapFields | null {
  const key = row.source_entity_id;
  const rule = rules.get(key);
  if (
    row.source_event_name !== CAPABILITY_GAP_SOURCE_EVENT_NAME
    || row.source_entity_type !== CAPABILITY_GAP_SOURCE_ENTITY_TYPE
    || !CAPABILITY_KEY.test(key)
    || !rule
    || (rule.coverage_state !== 'uncovered' && rule.coverage_state !== 'partial')
    || !Array.isArray(rule.required_source_types)
    || !rule.required_source_types.every((type) => (KNOWN_SOURCE_TYPES as readonly string[]).includes(type))
    || !nonNegativeInteger(rule.minimum_authority_tier)
    || !nonNegativeInteger(rule.minimum_source_count)
    || !nonNegativeInteger(rule.matched_sources)
  ) {
    return null;
  }
  return {
    capabilityKey: key,
    coverageState: rule.coverage_state,
    requiredSourceTypes: rule.required_source_types,
    minimumAuthorityTier: rule.minimum_authority_tier,
    minimumSourceCount: rule.minimum_source_count,
    matchedSources: rule.matched_sources,
  };
}

/**
 * Is this requirement about NO child, and therefore exportable?
 *
 * WHICH ATHLETE A ROW NAMES is shadowResearch's question, and
 * subjectAthleteIdOf is its answer: the dedicated subject_id COLUMN first,
 * then the metadata fallbacks, in the priority order every other reader uses
 * (shadowResearch.ts -- "subject_id is the authority"). The metadata keys
 * hasSubjectLink refuses are refused as well, so a row is excluded if either
 * finds somebody.
 *
 * Only capability-coverage gaps are exportable. Library claim rows are not:
 * their knowledge_gap quotes the question a member typed, which may name a
 * child or a health detail that redaction does not catch.
 */
function namesNobody(row: ShadowResearchRequirementRow): boolean {
  return subjectAthleteIdOf(row) === null && !hasSubjectLink(row.metadata ?? {});
}

export function sanitizeResearchNeeds(
  rows: ShadowResearchRequirementRow[],
  capabilityRules: ShadowCapabilityCoverageRow[],
): SanitizedResearchNeed[] {
  const rules = new Map(capabilityRules.map((rule) => [rule.capability_key, rule]));
  return rows
    .flatMap((row) => {
      const fields = namesNobody(row) ? capabilityGapFieldsOf(row, rules) : null;
      return fields ? [{ row, fields }] : [];
    })
    // Newest first, so the cap keeps the gaps the coverage check saw last.
    // (node-postgres hands timestamptz back as a Date and bigserial as a
    // string, whatever the row type says, so both are compared as numbers.)
    .sort((a, b) => (
      new Date(b.row.created_at).getTime() - new Date(a.row.created_at).getTime()
      || Number(b.row.research_requirement_id) - Number(a.row.research_requirement_id)
    ))
    .slice(0, RESEARCH_BRIDGE_MAX_NEEDS)
    .map(({ row, fields }) => {
      const text = buildCapabilityGapResearchFields(fields);
      return {
        id: opaqueId('need', row.organization_id, String(row.research_requirement_id)),
        title: redactResearchText(text.requirement, 500),
        knowledge_gap: redactResearchText(text.knowledgeGap),
        // The values syncCapabilityGapRequirement writes, not the row's.
        evidence_status: text.sourceStatus,
        confidence_tier: 'INSUFFICIENT',
        verification_state: 'unknown',
        status: row.status,
        created_at: row.created_at,
      };
    });
}

function safePublicUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return null;
    }
    const serialized = url.toString();
    return serialized.length <= RESEARCH_BRIDGE_MAX_URL_LENGTH ? serialized : null;
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
    .filter((row) => row.title.length > 0 && row.excerpt.length > 0)
    .slice(0, RESEARCH_BRIDGE_MAX_EVIDENCE);
}

export async function buildResearchBridgeExport(organizationId: string) {
  const [researchNeeds, capabilityRules, approvedEvidence] = await Promise.all([
    listShadowResearchRequirements(organizationId),
    listShadowCapabilityCoverage(organizationId),
    listApprovedGlobalEvidenceForResearchBridge({ organizationId, limit: RESEARCH_BRIDGE_MAX_EVIDENCE }),
  ]);

  return {
    schema_version: '1' as const,
    classification: 'sanitized-staging-only' as const,
    generated_at: new Date().toISOString(),
    research_needs: sanitizeResearchNeeds(researchNeeds, capabilityRules),
    approved_evidence: sanitizeApprovedEvidence(organizationId, approvedEvidence),
  };
}
