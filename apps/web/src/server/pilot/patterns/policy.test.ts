/**
 * The policy guardrails exist to stop a threshold from being invented, or
 * from drifting below the floor that stated PPBF methodology already sets.
 */

import { assertPatternFormationPolicy, policyParameters, type PatternFormationPolicy } from './policy';

const valid: PatternFormationPolicy = {
  policyVersion: 'pattern-policy-v0-test-not-ratified',
  ratifiedByAccountId: 'account-owner-1',
  ratifiedAt: '2026-01-01T00:00:00.000Z',
  minimumOccurrences: 4,
  minimumDistinctSessions: 3,
  minimumDistinctTaskContexts: 2,
  minimumDistinctObservers: 2,
  requireHumanObservation: true,
  requireConstraintSpan: true,
  requireFatigueDiversity: true,
  requireVideoCorroboration: false,
  counterEvidenceContestRatio: 0.5,
  minimumAthleteAttributionShare: 0.6,
  evidenceStaleAfterDays: 90,
  minimumObservationSpanDays: 0,
};

describe('pattern formation policy', () => {
  test('accepts a coherent, attributed, versioned policy', () => {
    expect(() => assertPatternFormationPolicy(valid)).not.toThrow();
  });

  test('a promotion bar must name the person who ratified it', () => {
    expect(() => assertPatternFormationPolicy({ ...valid, ratifiedByAccountId: '' }))
      .toThrow(/attributable to a person/);
    expect(() => assertPatternFormationPolicy({ ...valid, policyVersion: '   ' }))
      .toThrow(/policyVersion/);
    expect(() => assertPatternFormationPolicy({ ...valid, ratifiedAt: 'whenever' }))
      .toThrow(/ratifiedAt/);
  });

  test('one rep, one session and one drill can never be configured as a pattern', () => {
    expect(() => assertPatternFormationPolicy({ ...valid, minimumOccurrences: 1, minimumDistinctSessions: 1, minimumDistinctTaskContexts: 1 }))
      .toThrow(/one dramatic event is not a pattern/);
    expect(() => assertPatternFormationPolicy({ ...valid, minimumDistinctSessions: 1 }))
      .toThrow(/a single session is one occasion/);
    expect(() => assertPatternFormationPolicy({ ...valid, minimumDistinctTaskContexts: 1 }))
      .toThrow(/artefact of that task/);
  });

  test('rejects an internally incoherent bar', () => {
    // Asking for evidence in 5 distinct sessions while accepting 4 total
    // occurrences is unsatisfiable, and would abstain forever without ever
    // saying why.
    expect(() => assertPatternFormationPolicy({ ...valid, minimumDistinctSessions: 5 }))
      .toThrow(/cannot exceed minimumOccurrences/);
    expect(() => assertPatternFormationPolicy({ ...valid, minimumOccurrences: 2, minimumDistinctTaskContexts: 3, minimumDistinctSessions: 2 }))
      .toThrow(/cannot exceed minimumOccurrences/);
  });

  test('ratios must be ratios and windows must be positive', () => {
    expect(() => assertPatternFormationPolicy({ ...valid, counterEvidenceContestRatio: 1.5 }))
      .toThrow(/counterEvidenceContestRatio/);
    expect(() => assertPatternFormationPolicy({ ...valid, minimumAthleteAttributionShare: -0.1 }))
      .toThrow(/minimumAthleteAttributionShare/);
    expect(() => assertPatternFormationPolicy({ ...valid, evidenceStaleAfterDays: 0 }))
      .toThrow(/evidenceStaleAfterDays/);
    expect(() => assertPatternFormationPolicy({ ...valid, minimumObservationSpanDays: -1 }))
      .toThrow(/minimumObservationSpanDays/);
  });

  test('rejects fractional counts rather than rounding them', () => {
    expect(() => assertPatternFormationPolicy({ ...valid, minimumOccurrences: 4.5 }))
      .toThrow(/integers of at least 1/);
  });

  test('stamps the full bar into parameters, not just a version string', () => {
    const parameters = policyParameters(valid);
    expect(parameters).toEqual({
      minimumOccurrences: 4,
      minimumDistinctSessions: 3,
      minimumDistinctTaskContexts: 2,
      minimumDistinctObservers: 2,
      requireHumanObservation: true,
      requireConstraintSpan: true,
      requireFatigueDiversity: true,
      requireVideoCorroboration: false,
      counterEvidenceContestRatio: 0.5,
      minimumAthleteAttributionShare: 0.6,
      evidenceStaleAfterDays: 90,
      minimumObservationSpanDays: 0,
    });
    expect(Object.isFrozen(parameters)).toBe(true);
  });

  test('this module ships no default policy', async () => {
    const policyModule = await import('./policy');
    const exported = Object.keys(policyModule);
    // A default bar would become the de-facto science the moment it existed.
    expect(exported).toEqual(expect.arrayContaining(['assertPatternFormationPolicy', 'policyParameters']));
    expect(exported.some((name) => /DEFAULT|STANDARD|RECOMMENDED/i.test(name))).toBe(false);
  });
});
