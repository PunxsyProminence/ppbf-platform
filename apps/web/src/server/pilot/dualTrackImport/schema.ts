// Reusable dual-track athlete program configuration schema.
// Generic to any athlete running a primary military/occupational-readiness
// track alongside a supporting sport-development track -- not specific to
// any one athlete's identity or data.

export type TrackRole = 'primary' | 'secondary';

export type MandatoryGateCategory =
  | 'recovery'
  | 'safety'
  | 'water_safety'
  | 'workload_management';

export const REQUIRED_MANDATORY_GATE_CATEGORIES: readonly MandatoryGateCategory[] = [
  'recovery',
  'safety',
  'water_safety',
  'workload_management',
];

// Conditioning domains the primary track owns. A secondary/support track
// (e.g. a sport skill program) may contribute to these but must never be
// configured as a substitute delivery mechanism for any of them.
export type CoreConditioningDomain =
  | 'running'
  | 'swimming'
  | 'rucking'
  | 'calisthenics'
  | 'water_confidence'
  | 'recovery';

export const CORE_CONDITIONING_DOMAINS: readonly CoreConditioningDomain[] = [
  'running',
  'swimming',
  'rucking',
  'calisthenics',
  'water_confidence',
  'recovery',
];

export interface TrackDefinition {
  trackRole: TrackRole;
  trackKey: string;
  displayName: string;
  description: string;
}

export interface SecondaryTrackDefinition extends TrackDefinition {
  trackRole: 'secondary';
  // Domains this track may support (e.g. footwork, composure, conditioning,
  // perception, motivation) -- distinct from the core domains it must never
  // replace.
  supportsDomains: string[];
  // Structural declaration that this track never substitutes for any core
  // conditioning domain. Validated against CORE_CONDITIONING_DOMAINS.
  neverReplacesDomains: CoreConditioningDomain[];
}

export interface DualTrackAthleteProgram {
  organizationId: string;
  athleteId: string;
  primaryTrack: TrackDefinition & { trackRole: 'primary' };
  secondaryTrack: SecondaryTrackDefinition;
  mandatoryGates: MandatoryGateCategory[];
  // Fixed by design: the primary track always controls total workload. This
  // field exists so the invariant is data as well as code, but its value is
  // constrained to 'primary' by validateDualTrackProgram.
  workloadAuthorityTrackRole: 'primary';
  hasRestrictedAdministrativeLane: boolean;
  status: 'draft' | 'active' | 'paused' | 'archived';
}

export interface DualTrackProgramValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateDualTrackProgram(program: DualTrackAthleteProgram): DualTrackProgramValidationResult {
  const errors: string[] = [];

  if (!program.organizationId) {
    errors.push('MISSING_ORGANIZATION_ID');
  }
  if (!program.athleteId) {
    errors.push('MISSING_ATHLETE_ID');
  }
  if (program.primaryTrack.trackRole !== 'primary') {
    errors.push('PRIMARY_TRACK_ROLE_MUST_BE_PRIMARY');
  }
  if (program.secondaryTrack.trackRole !== 'secondary') {
    errors.push('SECONDARY_TRACK_ROLE_MUST_BE_SECONDARY');
  }
  if (program.workloadAuthorityTrackRole !== 'primary') {
    errors.push('WORKLOAD_AUTHORITY_MUST_REMAIN_WITH_PRIMARY_TRACK');
  }

  const missingGates = REQUIRED_MANDATORY_GATE_CATEGORIES.filter(
    (gate) => !program.mandatoryGates.includes(gate),
  );
  if (missingGates.length > 0) {
    errors.push(`MISSING_MANDATORY_GATES:${missingGates.join(',')}`);
  }

  const missingNeverReplace = CORE_CONDITIONING_DOMAINS.filter(
    (domain) => !program.secondaryTrack.neverReplacesDomains.includes(domain),
  );
  if (missingNeverReplace.length > 0) {
    errors.push(`SECONDARY_TRACK_MUST_DECLARE_NEVER_REPLACES:${missingNeverReplace.join(',')}`);
  }

  const overlap = program.secondaryTrack.supportsDomains.filter((domain) =>
    (CORE_CONDITIONING_DOMAINS as readonly string[]).includes(domain),
  );
  if (overlap.length > 0) {
    errors.push(`SECONDARY_TRACK_CANNOT_CLAIM_CORE_DOMAIN_AS_SUPPORT:${overlap.join(',')}`);
  }

  return { valid: errors.length === 0, errors };
}
