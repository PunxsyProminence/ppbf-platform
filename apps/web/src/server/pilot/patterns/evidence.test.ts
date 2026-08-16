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
  test('two observers, same session and task, opposite calls is disagreement', () => {
    expect(detectObserverDisagreement([
      obs(1, { sessionId: 'session-1', taskContextKey: 'task-a', observerAccountId: 'coach-a' }),
      obs(2, { sessionId: 'session-1', taskContextKey: 'task-a', observerAccountId: 'coach-b', polarity: 'counterexample' }),
    ])).toBe(true);
  });

  test('different drills is ordinary variation, not disagreement', () => {
    expect(detectObserverDisagreement([
      obs(1, { sessionId: 'session-1', taskContextKey: 'task-a', observerAccountId: 'coach-a' }),
      obs(2, { sessionId: 'session-1', taskContextKey: 'task-b', observerAccountId: 'coach-b', polarity: 'counterexample' }),
    ])).toBe(false);
  });

  test('one observer revising their own call is not two people disagreeing', () => {
    expect(detectObserverDisagreement([
      obs(1, { sessionId: 'session-1', taskContextKey: 'task-a', observerAccountId: 'coach-a' }),
      obs(2, { sessionId: 'session-1', taskContextKey: 'task-a', observerAccountId: 'coach-a', polarity: 'counterexample' }),
    ])).toBe(false);
  });

  test('video contradicting a coach on the same task is flagged', () => {
    expect(detectVideoContradiction([
      obs(1, { sessionId: 'session-1', taskContextKey: 'task-a' }),
      obs(2, {
        sessionId: 'session-1',
        taskContextKey: 'task-a',
        polarity: 'counterexample',
        observerAccountId: null,
        source: { type: 'computer_vision', quality: 'verified', referenceId: 'clip-1' },
      }),
    ])).toBe(true);
  });

  test('video agreeing with a coach is not a contradiction', () => {
    expect(detectVideoContradiction([
      obs(1, { sessionId: 'session-1', taskContextKey: 'task-a' }),
      obs(2, {
        sessionId: 'session-1',
        taskContextKey: 'task-a',
        observerAccountId: null,
        source: { type: 'computer_vision', quality: 'verified', referenceId: 'clip-1' },
      }),
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
});
