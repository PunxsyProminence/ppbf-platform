import { citationsFrom, parametersFor } from './learningPolicies';

// No numbers here are a recommendation: they are fixtures that satisfy the
// library's coherence rules, so the tests can show what is refused and why.
// The real bar comes from research and Jason (Q3, "Needs to be backed by
// research"), entered by a gym admin.

const STAMP = { policyVersion: '1', ratifiedByAccountId: 'acct-office', ratifiedAt: '2026-10-18T00:00:00.000Z' };

const PATTERN = {
  minimumOccurrences: 3,
  minimumDistinctSessions: 2,
  minimumDistinctTaskContexts: 2,
  minimumDistinctObservers: 1,
  requireHumanObservation: true,
  requireConstraintSpan: false,
  requireFatigueDiversity: false,
  requireVideoCorroboration: false,
  counterEvidenceContestRatio: 0.5,
  minimumAthleteAttributionShare: 0.75,
  evidenceStaleAfterDays: 42,
  minimumObservationSpanDays: 0,
};

const LESSON = {
  minimumTransferContexts: 1,
  retentionWindowDays: 14,
  minimumRetentionObservations: 2,
  requireHumanReviewedOutcome: true,
  acceptedMatchStates: ['match', 'partial'],
};

describe('citations', () => {
  test('a bar needs at least one source, each named', () => {
    expect(() => citationsFrom([])).toThrow('at least one cited source');
    expect(() => citationsFrom(undefined)).toThrow('at least one cited source');
    expect(() => citationsFrom([{ note: 'no source' }])).toThrow('names its source');
    expect(() => citationsFrom([{ source: '   ' }])).toThrow('names its source');
    expect(() => citationsFrom(Array.from({ length: 21 }, () => ({ source: 's' })))).toThrow('at most 20');
    expect(citationsFrom([{ source: ' Kratochwill et al. 2013 ', note: ' phase length ' }, { source: 'B' }]))
      .toEqual([{ source: 'Kratochwill et al. 2013', note: 'phase length' }, { source: 'B' }]);
  });
});

describe('parameters', () => {
  test('a coherent bar of each kind passes through unchanged', () => {
    expect(parametersFor('pattern_formation', PATTERN, STAMP)).toEqual(PATTERN);
    expect(parametersFor('athlete_lesson', LESSON, STAMP)).toEqual(LESSON);
  });

  test('exactly the fields of the kind: none missing, none extra', () => {
    const missing: Record<string, unknown> = { ...PATTERN };
    delete missing.minimumOccurrences;
    expect(() => parametersFor('pattern_formation', missing, STAMP)).toThrow('Missing: minimumOccurrences');
    expect(() => parametersFor('pattern_formation', { ...PATTERN, policyVersion: '9' }, STAMP)).toThrow('Not a field: policyVersion');
    expect(() => parametersFor('athlete_lesson', PATTERN, STAMP)).toThrow('A athlete_lesson bar carries exactly');
    expect(() => parametersFor('pattern_formation', [1, 2], STAMP)).toThrow('an object');
  });

  test("the library's own rules refuse an incoherent bar, as a 400 reason", () => {
    // One rep is never a pattern: the floors of 2 (patterns/policy.ts).
    expect(() => parametersFor('pattern_formation', { ...PATTERN, minimumOccurrences: 1 }, STAMP)).toThrow();
    expect(() => parametersFor('pattern_formation', { ...PATTERN, counterEvidenceContestRatio: 2 }, STAMP)).toThrow('ratio');
    // A confounded outcome can never validate a lesson (patterns/lessons.ts).
    expect(() => parametersFor('athlete_lesson', { ...LESSON, acceptedMatchStates: ['match', 'confounded'] }, STAMP))
      .toThrow('confounded');
    expect(() => parametersFor('athlete_lesson', { ...LESSON, requireHumanReviewedOutcome: false }, STAMP))
      .toThrow('cannot be disabled');
    try {
      parametersFor('pattern_formation', { ...PATTERN, minimumOccurrences: 1 }, STAMP);
    } catch (error) {
      expect((error as { status?: number }).status).toBe(400);
    }
  });
});
