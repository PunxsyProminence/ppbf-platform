/**
 * The summarizers carry the subtle judgements, so they are tested directly
 * rather than only through `evaluatePatternCandidate`. Each case here is a
 * place where a plausible simpler implementation would quietly overstate the
 * evidence.
 */

import {
  admitObservations,
  detectObserverDisagreement,
  detectVideoContradiction,
  recentOccurrenceCount,
  summarizeAttribution,
  summarizeContextDiversity,
  summarizeCounterEvidence,
  summarizeEvidence,
} from './evidence';
import type { BehaviourObservation } from './types';

const ORG = 'org-1';
const ATHLETE = 'athlete-1';
const BEHAVIOUR = 'drops_lead_hand_after_jab';
const SCOPE = { organizationId: ORG, athleteId: ATHLETE, behaviourKey: BEHAVIOUR };

function obs(
  index: number,
  overrides: Partial<BehaviourObservation> = {},
): BehaviourObservation {
  return {
    observationId: `obs-${index}`,
    organizationId: ORG,
    athleteId: ATHLETE,
    behaviourKey: BEHAVIOUR,
    sessionId: `session-${index}`,
    taskContextKey: 'task-mitts',
    taskConstraint: 'controlled',
    fatigueContext: 'fresh',
    observedAt: `2026-06-${String(index).padStart(2, '0')}T10:00:00.000Z`,
    source: { type: 'coach_tag', quality: 'high', referenceId: `ref-${index}` },
    observerAccountId: 'coach-a',
    interpretation: 'human_observed',
    polarity: 'occurrence',
    attribution: { target: 'athlete', certainty: 'probable' },
    ...overrides,
  };
}

describe('observation admission', () => {
  test('is deterministic regardless of input order', () => {
    const observations = [obs(3), obs(1), obs(2)];
    const forward = admitObservations(SCOPE, observations);
    const reversed = admitObservations(SCOPE, [...observations].reverse());
    expect(forward.admitted.map((item) => item.observationId))
      .toEqual(reversed.admitted.map((item) => item.observationId));
    expect(forward.admitted.map((item) => item.observationId)).toEqual(['obs-1', 'obs-2', 'obs-3']);
  });

  test('reports duplicates rather than double-counting them', () => {
    const admission = admitObservations(SCOPE, [obs(1), obs(1)]);
    expect(admission.admitted).toHaveLength(1);
    expect(admission.excluded).toEqual([{ observationId: 'obs-1', reason: 'DUPLICATE_OBSERVATION_ID' }]);
  });

  test('an in-scope revision still supersedes the call it replaces', () => {
    const admission = admitObservations(SCOPE, [obs(1), obs(2, { supersedesObservationId: 'obs-1' })]);
    expect(admission.admitted.map((item) => item.observationId)).toEqual(['obs-2']);
    expect(admission.excluded).toEqual([{ observationId: 'obs-1', reason: 'SUPERSEDED_OBSERVATION' }]);
  });

  // A record that is itself thrown out cannot reach back and remove evidence
  // it has no standing over: another athlete's revision, a mis-keyed import
  // or a failed capture naming a valid id would otherwise erase it silently.
  test.each([
    ['another organization', { organizationId: 'org-2' }, 'ORGANIZATION_SCOPE_MISMATCH'],
    ['another athlete', { athleteId: 'athlete-2' }, 'ATHLETE_SCOPE_MISMATCH'],
    ['another behaviour', { behaviourKey: 'other_behaviour' }, 'BEHAVIOUR_KEY_MISMATCH'],
    ['an unreadable timestamp', { observedAt: 'not-a-date' }, 'INVALID_TIMESTAMP'],
    ['a failed capture', { source: { type: 'coach_tag', quality: 'failed', referenceId: 'ref-2' } }, 'SOURCE_QUALITY_FAIL'],
  ] as const)('a replacement from %s cannot supersede a valid observation', (_label, overrides, reason) => {
    const admission = admitObservations(SCOPE, [
      obs(1),
      obs(2, { ...overrides, supersedesObservationId: 'obs-1' } as Partial<BehaviourObservation>),
    ]);
    expect(admission.admitted.map((item) => item.observationId)).toEqual(['obs-1']);
    expect(admission.excluded).toEqual([{ observationId: 'obs-2', reason }]);
  });

  test('a revision that is itself revised still removes the original', () => {
    const admission = admitObservations(SCOPE, [
      obs(1),
      obs(2, { supersedesObservationId: 'obs-1' }),
      obs(3, { supersedesObservationId: 'obs-2' }),
    ]);
    expect(admission.admitted.map((item) => item.observationId)).toEqual(['obs-3']);
    expect(admission.excluded.map((item) => item.reason))
      .toEqual(['SUPERSEDED_OBSERVATION', 'SUPERSEDED_OBSERVATION']);
  });

  test('a record naming itself as superseded stays excluded, as it always was', () => {
    const admission = admitObservations(SCOPE, [obs(1, { supersedesObservationId: 'obs-1' })]);
    expect(admission.admitted).toEqual([]);
    expect(admission.excluded).toEqual([{ observationId: 'obs-1', reason: 'SUPERSEDED_OBSERVATION' }]);
  });

  test('with asOf, later records are left out and a later revision does not apply yet', () => {
    const admission = admitObservations(SCOPE, [
      obs(1),
      // Observed exactly at asOf: already made, so admitted.
      obs(10, { observedAt: '2026-06-10T00:00:00.000Z' }),
      obs(20, { supersedesObservationId: 'obs-1' }),
      obs(13, { observedAt: 'not-a-date' }),
    ], '2026-06-10T00:00:00.000Z');
    expect(admission.admitted.map((item) => item.observationId)).toEqual(['obs-1', 'obs-10']);
    // Unreadable timestamps are still reported; they cannot be placed after asOf.
    expect(admission.excluded).toEqual([{ observationId: 'obs-13', reason: 'INVALID_TIMESTAMP' }]);
    expect(() => admitObservations(SCOPE, [obs(1)], 'whenever')).toThrow(/valid timestamp/);
  });

  test('a duplicate record cannot supersede through the copy that was dropped', () => {
    const admission = admitObservations(SCOPE, [
      obs(1),
      obs(2),
      obs(2, { observedAt: '2026-06-03T10:00:00.000Z', supersedesObservationId: 'obs-1' }),
    ]);
    expect(admission.admitted.map((item) => item.observationId)).toEqual(['obs-1', 'obs-2']);
    expect(admission.excluded).toEqual([{ observationId: 'obs-2', reason: 'DUPLICATE_OBSERVATION_ID' }]);
  });
});

describe('evidence summary', () => {
  test('counts diversity over occurrences only, never over counterexamples', () => {
    const evidence = summarizeEvidence([
      obs(1, { taskContextKey: 'task-a', sessionId: 'session-1' }),
      obs(2, { taskContextKey: 'task-a', sessionId: 'session-2' }),
      // A counterexample in a third drill is evidence AGAINST; letting it
      // widen distinctTaskContexts would make disagreement look like breadth.
      obs(3, { taskContextKey: 'task-b', sessionId: 'session-3', polarity: 'counterexample' }),
    ]);
    expect(evidence.occurrenceCount).toBe(2);
    expect(evidence.counterexampleCount).toBe(1);
    expect(evidence.distinctTaskContexts).toBe(1);
    expect(evidence.distinctSessions).toBe(2);
  });

  test('three observations inside one session are one session of evidence', () => {
    const evidence = summarizeEvidence([
      obs(1, { sessionId: 'session-1' }),
      obs(2, { sessionId: 'session-1' }),
      obs(3, { sessionId: 'session-1' }),
    ]);
    expect(evidence.occurrenceCount).toBe(3);
    expect(evidence.distinctSessions).toBe(1);
  });

  test('reports the observed span without inventing one for a single point', () => {
    expect(summarizeEvidence([obs(1)]).observedSpanDays).toBe(0);
    expect(summarizeEvidence([]).observedSpanDays).toBeNull();
    expect(summarizeEvidence([]).firstObservedAt).toBeNull();
  });
});

describe('context diversity', () => {
  test('an unrecorded fatigue state is not a confined one', () => {
    const diversity = summarizeContextDiversity([
      obs(1, { fatigueContext: 'fatigued' }),
      obs(2, { fatigueContext: 'unknown' }),
    ]);
    expect(diversity.fatigueConfined).toBe(false);
    expect(diversity.confinedFatigueContext).toBeNull();
  });

  test('confinement requires every occurrence to agree on a known state', () => {
    const diversity = summarizeContextDiversity([
      obs(1, { fatigueContext: 'fatigued' }),
      obs(2, { fatigueContext: 'fatigued' }),
    ]);
    expect(diversity.fatigueConfined).toBe(true);
    expect(diversity.confinedFatigueContext).toBe('fatigued');
  });

  test('constrained-live counts as live exposure but not as controlled', () => {
    const diversity = summarizeContextDiversity([
      obs(1, { taskConstraint: 'constrained_live' }),
      obs(2, { taskConstraint: 'constrained_live' }),
    ]);
    expect(diversity.hasLiveContext).toBe(true);
    expect(diversity.hasControlledContext).toBe(false);
    expect(diversity.spansConstraintTypes).toBe(false);
  });
});

describe('attribution summary', () => {
  test('a tie has no leader', () => {
    const attribution = summarizeAttribution([
      obs(1, { attribution: { target: 'athlete', certainty: 'probable' } }),
      obs(2, { attribution: { target: 'coach_cue', certainty: 'probable' } }),
    ]);
    expect(attribution.leading).toBeNull();
    expect(attribution.athleteShare).toBe(0.5);
    expect(attribution.nonAthleteImplicated).toBe(true);
  });

  test('counterexamples attribute nothing', () => {
    const attribution = summarizeAttribution([
      obs(1, { attribution: { target: 'athlete', certainty: 'probable' } }),
      obs(2, { polarity: 'counterexample', attribution: { target: 'coach_cue', certainty: 'stated' } }),
    ]);
    expect(attribution.tally.coach_cue).toBe(0);
    expect(attribution.athleteShare).toBe(1);
  });

  test('reports no share at all when there is nothing to attribute', () => {
    expect(summarizeAttribution([]).athleteShare).toBeNull();
    expect(summarizeAttribution([]).leading).toBeNull();
  });
});

describe('counter-evidence summary', () => {
  test('notices when the most recent word on a behaviour is a counterexample', () => {
    const counter = summarizeCounterEvidence([
      obs(1),
      obs(5, { polarity: 'counterexample' }),
    ]);
    expect(counter.isMostRecentEvidence).toBe(true);
    expect(counter.ratioToOccurrences).toBe(1);
  });

  test('reports no ratio when there is nothing to compare against', () => {
    expect(summarizeCounterEvidence([obs(1, { polarity: 'counterexample' })]).ratioToOccurrences).toBeNull();
  });
});

describe('disagreement detection', () => {
  const SAME_REP = { sessionId: 'session-1', taskContextKey: 'task-a', opportunityKey: 'rep-1' } as const;
  const CLIP = { type: 'computer_vision', quality: 'verified', referenceId: 'clip-1' } as const;

  test('two observers, same attempt, opposite calls is disagreement', () => {
    expect(detectObserverDisagreement([
      obs(1, { ...SAME_REP, observerAccountId: 'coach-a' }),
      obs(2, { ...SAME_REP, observerAccountId: 'coach-b', polarity: 'counterexample' }),
    ])).toBe(true);
  });

  test('different drills is ordinary variation, not disagreement', () => {
    expect(detectObserverDisagreement([
      obs(1, { ...SAME_REP, observerAccountId: 'coach-a' }),
      obs(2, { ...SAME_REP, taskContextKey: 'task-b', observerAccountId: 'coach-b', polarity: 'counterexample' }),
    ])).toBe(false);
  });

  test('two coaches scoring different reps of the same drill are not disagreeing', () => {
    // Same session, same task, opposite polarity -- but coach-a called rep 1
    // and coach-b called rep 4.
    expect(detectObserverDisagreement([
      obs(1, { ...SAME_REP, observerAccountId: 'coach-a' }),
      obs(2, { ...SAME_REP, opportunityKey: 'rep-4', observerAccountId: 'coach-b', polarity: 'counterexample' }),
    ])).toBe(false);
  });

  test.each([undefined, null, ''])('a reading with no attempt identified (%p) is never compared', (opportunityKey) => {
    // Nothing says these two watched the same attempt, so neither can be
    // set against the other -- for coaches or for film.
    expect(detectObserverDisagreement([
      obs(1, { ...SAME_REP, observerAccountId: 'coach-a' }),
      obs(2, { ...SAME_REP, opportunityKey, observerAccountId: 'coach-b', polarity: 'counterexample' }),
    ])).toBe(false);
    // Neither reading identified: still nothing to compare.
    expect(detectObserverDisagreement([
      obs(1, { ...SAME_REP, opportunityKey, observerAccountId: 'coach-a' }),
      obs(2, { ...SAME_REP, opportunityKey, observerAccountId: 'coach-b', polarity: 'counterexample' }),
    ])).toBe(false);
    expect(detectVideoContradiction([
      obs(1, { ...SAME_REP, opportunityKey }),
      obs(2, { ...SAME_REP, polarity: 'counterexample', observerAccountId: null, source: CLIP }),
    ])).toBe(false);
  });

  test('one observer revising their own call is not two people disagreeing', () => {
    expect(detectObserverDisagreement([
      obs(1, { ...SAME_REP, observerAccountId: 'coach-a' }),
      obs(2, { ...SAME_REP, observerAccountId: 'coach-a', polarity: 'counterexample' }),
    ])).toBe(false);
  });

  test('video contradicting a coach on the same attempt is flagged', () => {
    expect(detectVideoContradiction([
      obs(1, { ...SAME_REP }),
      obs(2, { ...SAME_REP, polarity: 'counterexample', observerAccountId: null, source: CLIP }),
    ])).toBe(true);
  });

  test('video of a different rep does not contradict the coach', () => {
    expect(detectVideoContradiction([
      obs(1, { ...SAME_REP }),
      obs(2, { ...SAME_REP, opportunityKey: 'rep-3', polarity: 'counterexample', observerAccountId: null, source: CLIP }),
    ])).toBe(false);
  });

  test('video agreeing with a coach is not a contradiction', () => {
    expect(detectVideoContradiction([
      obs(1, { ...SAME_REP }),
      obs(2, { ...SAME_REP, observerAccountId: null, source: CLIP }),
    ])).toBe(false);
  });
});

describe('recency', () => {
  test('counts only occurrences inside the staleness horizon', () => {
    const observations = [
      obs(1, { observedAt: '2026-01-01T00:00:00.000Z' }),
      obs(2, { observedAt: '2026-06-01T00:00:00.000Z' }),
      obs(3, { observedAt: '2026-06-15T00:00:00.000Z', polarity: 'counterexample' }),
    ];
    expect(recentOccurrenceCount(observations, '2026-07-01T00:00:00.000Z', 90)).toBe(1);
    expect(recentOccurrenceCount(observations, '2026-07-01T00:00:00.000Z', 365)).toBe(2);
  });

  test('an occurrence recorded after asOf is not recent evidence at asOf', () => {
    const observations = [obs(1, { observedAt: '2026-08-01T00:00:00.000Z' })];
    expect(recentOccurrenceCount(observations, '2026-07-01T00:00:00.000Z', 90)).toBe(0);
    // Observed exactly at asOf still counts.
    expect(recentOccurrenceCount([obs(2, { observedAt: '2026-07-01T00:00:00.000Z' })], '2026-07-01T00:00:00.000Z', 90))
      .toBe(1);
  });
});
