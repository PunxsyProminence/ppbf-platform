// Source-classification and deduplication manifest schema for documents
// discovered while assembling an athlete's dual-track program record.
//
// Intentionally does not include a raw URL/path field. Source location
// identifiers are kept out-of-band from any file that could be committed to
// Git; this schema only carries an opaque local reference key plus enough
// provenance to make dedup/authority decisions auditable without exposing
// the private link itself.

import type { PrivacyClassification } from './privacyClassification';

export type SourceSystem = 'microsoft' | 'google';

export interface SourceRecord {
  // Opaque local key, not a URL/path/library ID. e.g. "src-001".
  sourceKey: string;
  system: SourceSystem;
  title: string;
  athleteSpecific: boolean;
  classification: PrivacyClassification;
  // SHA-256 of normalized document content, when computable. Used for
  // dedup; null means dedup for this item could not be content-verified.
  contentSha256: string | null;
  // Best-known modification/version date for the source, if any. This alone
  // must never be used to select authority (see validateDuplicateGroup).
  versionOrModifiedAt: string | null;
  discoveryQuery: string;
  provenanceNote: string;
}

export interface DuplicateGroup {
  groupId: string;
  memberSourceKeys: string[];
  selectedAuthoritySourceKey: string | null;
  // Must explain what content difference (not just a later timestamp)
  // justified the authority pick. See validateDuplicateGroup.
  selectionRationale: string;
  // True only when every group member's content has actually been diffed.
  contentCompared: boolean;
}

export interface SourceManifest {
  organizationId: string;
  athleteId: string;
  generatedAt: string;
  sources: SourceRecord[];
  duplicateGroups: DuplicateGroup[];
}

export interface ManifestValidationResult {
  valid: boolean;
  errors: string[];
}

const DATE_ONLY_RATIONALE_PATTERN = /\b(most recent|latest|newer|newest)\b/i;
const CONTENT_COMPARISON_PATTERN = /\b(content|diff|compared|text|section|clause)\b/i;

export function validateDuplicateGroup(group: DuplicateGroup): ManifestValidationResult {
  const errors: string[] = [];

  if (group.memberSourceKeys.length < 2) {
    errors.push('DUPLICATE_GROUP_REQUIRES_AT_LEAST_TWO_MEMBERS');
  }

  if (group.selectedAuthoritySourceKey && !group.memberSourceKeys.includes(group.selectedAuthoritySourceKey)) {
    errors.push('SELECTED_AUTHORITY_MUST_BE_A_GROUP_MEMBER');
  }

  if (group.selectedAuthoritySourceKey) {
    if (!group.contentCompared) {
      errors.push('AUTHORITY_SELECTION_REQUIRES_CONTENT_COMPARISON');
    }
    if (!group.selectionRationale.trim()) {
      errors.push('AUTHORITY_SELECTION_REQUIRES_RATIONALE');
    } else if (
      DATE_ONLY_RATIONALE_PATTERN.test(group.selectionRationale) &&
      !CONTENT_COMPARISON_PATTERN.test(group.selectionRationale)
    ) {
      errors.push('AUTHORITY_SELECTION_RATIONALE_APPEARS_DATE_ONLY');
    }
  }

  return { valid: errors.length === 0, errors };
}

export function validateSourceManifest(manifest: SourceManifest): ManifestValidationResult {
  const errors: string[] = [];

  if (!manifest.organizationId) errors.push('MISSING_ORGANIZATION_ID');
  if (!manifest.athleteId) errors.push('MISSING_ATHLETE_ID');

  const knownKeys = new Set(manifest.sources.map((s) => s.sourceKey));

  for (const group of manifest.duplicateGroups) {
    const groupResult = validateDuplicateGroup(group);
    if (!groupResult.valid) {
      errors.push(...groupResult.errors.map((e) => `${group.groupId}:${e}`));
    }
    for (const key of group.memberSourceKeys) {
      if (!knownKeys.has(key)) {
        errors.push(`${group.groupId}:UNKNOWN_SOURCE_KEY:${key}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
