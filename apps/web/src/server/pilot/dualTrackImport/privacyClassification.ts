// Privacy classification tiers for dual-track athlete program data.
// See ACCESS_CONTROL_MATRIX.md for the full role x classification matrix.

export type PrivacyClassification =
  | 'athlete_private'
  | 'organization_doctrine'
  | 'admin_restricted'
  | 'support_reference';

export const PRIVACY_CLASSIFICATIONS: readonly PrivacyClassification[] = [
  'athlete_private',
  'organization_doctrine',
  'admin_restricted',
  'support_reference',
];

// Destination tables each classification is permitted to target, expressed
// as the existing pilot.* tables verified against
// infra/azure/pilot_slice_postgres.sql on branch agent/shadow-trust-foundation
// @ e73829f. admin_restricted and support_reference intentionally map to no
// destination: no table in the current schema enforces an access tier that
// would keep recruiter/financial/military content out of ordinary coach
// reach, so this package refuses to plan any write for them rather than
// invent an unenforced one.
export const CLASSIFICATION_DESTINATION_TABLES: Record<PrivacyClassification, readonly string[]> = {
  athlete_private: [
    'pilot.sessions',
    'pilot.readiness',
    'pilot.assessments',
    'pilot.goals',
    'pilot.coach_observations',
    'pilot.shadow_formula_observations',
    'pilot.attendance',
  ],
  organization_doctrine: [
    'pilot.shadow_library_sources',
    'pilot.shadow_library_documents',
    'pilot.shadow_library_chunks',
  ],
  admin_restricted: [],
  support_reference: [],
};

// General SHADOW library / SHADOW chat evidence retrieval (shadowLibrary.ts
// searchShadowLibrary, shadowEvidence.ts retrieveShadowEvidenceBundle) has no
// classification-aware filter today -- it scopes by organization/subject and
// approval+verification+ingest state only. Anything approved there becomes
// visible to any actor who already has legitimate athlete/org access.
// Therefore admin_restricted and unapproved support_reference content must
// never be routed there.
const GENERAL_SHADOW_LIBRARY_TABLES: readonly string[] = [
  'pilot.shadow_library_sources',
  'pilot.shadow_library_documents',
  'pilot.shadow_library_chunks',
];

export function isDestinationAllowedForClassification(
  classification: PrivacyClassification,
  destinationTable: string,
): boolean {
  return CLASSIFICATION_DESTINATION_TABLES[classification].includes(destinationTable);
}

export function isRestrictedFromGeneralShadowLibrary(classification: PrivacyClassification): boolean {
  return classification === 'admin_restricted' || classification === 'support_reference';
}

export function targetsGeneralShadowLibrary(destinationTable: string): boolean {
  return GENERAL_SHADOW_LIBRARY_TABLES.includes(destinationTable);
}

// Ordinary coach reach: coaches may see athlete_private evidence for athletes
// they are assigned to (see access.ts assertCoachAssignedToAthlete) and
// approved organization_doctrine. They must never receive admin_restricted
// content, and support_reference is not evidence-grade so it is never
// surfaced to any role through the ordinary athlete/coach data paths.
const COACH_VISIBLE_CLASSIFICATIONS: readonly PrivacyClassification[] = [
  'athlete_private',
  'organization_doctrine',
];

export function isVisibleToOrdinaryCoach(classification: PrivacyClassification): boolean {
  return COACH_VISIBLE_CLASSIFICATIONS.includes(classification);
}

export function hasSecureDestination(classification: PrivacyClassification): boolean {
  return CLASSIFICATION_DESTINATION_TABLES[classification].length > 0;
}
