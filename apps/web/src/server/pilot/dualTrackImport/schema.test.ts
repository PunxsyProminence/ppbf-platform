import {
  CORE_CONDITIONING_DOMAINS,
  REQUIRED_MANDATORY_GATE_CATEGORIES,
  type DualTrackAthleteProgram,
  validateDualTrackProgram,
} from './schema';

function validProgram(): DualTrackAthleteProgram {
  return {
    organizationId: 'org-example',
    athleteId: 'athlete-example-0001',
    primaryTrack: {
      trackRole: 'primary',
      trackKey: 'occupational_readiness_prep',
      displayName: 'Example primary readiness track',
      description: 'Placeholder description for a primary occupational-readiness track.',
    },
    secondaryTrack: {
      trackRole: 'secondary',
      trackKey: 'adaptive_sport_development',
      displayName: 'Example secondary sport-development track',
      description: 'Placeholder description for a supporting sport track.',
      supportsDomains: ['footwork', 'composure', 'perception', 'motivation'],
      neverReplacesDomains: [...CORE_CONDITIONING_DOMAINS],
    },
    mandatoryGates: [...REQUIRED_MANDATORY_GATE_CATEGORIES],
    workloadAuthorityTrackRole: 'primary',
    hasRestrictedAdministrativeLane: true,
    status: 'draft',
  };
}

describe('dual-track athlete program schema', () => {
  it('accepts a well-formed program', () => {
    const result = validateDualTrackProgram(validProgram());
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects a program missing a mandatory gate category', () => {
    const program = validProgram();
    program.mandatoryGates = program.mandatoryGates.filter((gate) => gate !== 'water_safety');
    const result = validateDualTrackProgram(program);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith('MISSING_MANDATORY_GATES'))).toBe(true);
  });

  it('rejects a secondary track that does not declare it never replaces a core domain', () => {
    const program = validProgram();
    program.secondaryTrack.neverReplacesDomains = program.secondaryTrack.neverReplacesDomains.filter(
      (domain) => domain !== 'running',
    );
    const result = validateDualTrackProgram(program);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith('SECONDARY_TRACK_MUST_DECLARE_NEVER_REPLACES'))).toBe(true);
  });

  it('rejects a secondary track that claims a core conditioning domain as something it supports', () => {
    const program = validProgram();
    program.secondaryTrack.supportsDomains = ['swimming'];
    const result = validateDualTrackProgram(program);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.startsWith('SECONDARY_TRACK_CANNOT_CLAIM_CORE_DOMAIN_AS_SUPPORT'))).toBe(true);
  });

  it('rejects workload authority being assigned away from the primary track', () => {
    const program = validProgram();
    // @ts-expect-error -- intentionally invalid value to prove the validator catches it
    program.workloadAuthorityTrackRole = 'secondary';
    const result = validateDualTrackProgram(program);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('WORKLOAD_AUTHORITY_MUST_REMAIN_WITH_PRIMARY_TRACK');
  });

  it('rejects a program missing organization or athlete scope', () => {
    const program = validProgram();
    program.organizationId = '';
    program.athleteId = '';
    const result = validateDualTrackProgram(program);
    expect(result.errors).toEqual(expect.arrayContaining(['MISSING_ORGANIZATION_ID', 'MISSING_ATHLETE_ID']));
  });
});
