import { assessDrift, buildSessionRateSeries } from './drift';
import type { PatternInferencePolicy } from './policy';
import type { BehaviourObservation } from '../types';

const policy: PatternInferencePolicy = {
  policyVersion: 'inference-policy-v0-test-not-ratified',
  ratifiedByAccountId: 'account-owner-1',
  ratifiedAt: '2026-01-01T00:00:00.000Z',
  recurrencePrior: { priorOccurrences: 1, priorNonOccurrences: 3 },
  sequentialTest: { nullRate: 0.2, alternativeRate: 0.6, falsePromotionRate: 0.05, missedPatternRate: 0.2 },
  posteriorWidth: { credibleMass: 0.9, maximumCredibleWidth: 0.4 },
  stratifiedAttribution: { concentration: 1, minimumStratumSize: 2 },
  drift: { ewmaLambda: 0.3, cusumSlack: 0.1, cusumThreshold: 0.4, minimumHistorySessions: 3 },
};

function point(session: number, day: number, polarity: BehaviourObservation['polarity']): BehaviourObservation {
  return {
    observationId: `obs-${session}-${polarity}`,
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    behaviourKey: 'drops_lead_hand_after_jab',
    sessionId: `session-${session}`,
    taskContextKey: 'task-mitts',
    taskConstraint: 'controlled',
    fatigueContext: 'fresh',
    observedAt: `2026-06-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    source: { type: 'coach_tag', quality: 'high', referenceId: `ref-${session}` },
    observerAccountId: 'coach-a',
    interpretation: 'human_observed',
    polarity,
    attribution: { target: 'athlete', certainty: 'probable' },
  };
}

/** One session per entry; 'occurrence' means it happened that session. */
function series(polarities: readonly BehaviourObservation['polarity'][]): BehaviourObservation[] {
  return polarities.map((polarity, index) => point(index + 1, index + 1, polarity));
}

describe('session rate series', () => {
  test('collapses to one point per session, time-ordered', () => {
    const points = buildSessionRateSeries([
      point(2, 5, 'occurrence'),
      point(1, 1, 'occurrence'),
      { ...point(1, 2, 'counterexample'), observationId: 'obs-1b' },
    ]);
    expect(points.map((p) => p.sessionId)).toEqual(['session-1', 'session-2']);
    // Three observations across two sessions: two points, not three.
    expect(points).toHaveLength(2);
    expect(points[0].trials).toBe(2);
    expect(points[0].rate).toBe(0.5);
  });

  test('is order-independent', () => {
    const observations = series(['occurrence', 'counterexample', 'occurrence']);
    expect(buildSessionRateSeries(observations).map((p) => p.sessionId))
      .toEqual(buildSessionRateSeries([...observations].reverse()).map((p) => p.sessionId));
  });
});

describe('drift detection (§2.5)', () => {
  test('too little history is reported as unchartable, not as flat', () => {
    const result = assessDrift(series(['occurrence', 'occurrence']), policy);
    expect(result.unavailableReason).toBe('INSUFFICIENT_HISTORY');
    expect(result.fading).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  test('a steady behaviour raises no flag', () => {
    const result = assessDrift(
      series(['occurrence', 'occurrence', 'occurrence', 'occurrence']),
      policy,
    );
    expect(result.unavailableReason).toBeNull();
    expect(result.shiftDown).toBe(false);
    expect(result.fading).toBe(false);
  });

  test('a behaviour that recedes is flagged as fading', () => {
    // Present for four sessions, then absent for four.
    const result = assessDrift(series([
      'occurrence', 'occurrence', 'occurrence', 'occurrence',
      'counterexample', 'counterexample', 'counterexample', 'counterexample',
    ]), policy);

    expect(result.shiftDown).toBe(true);
    expect(result.fading).toBe(true);
    expect(result.reasons).toContain('PATTERN_FADING');
  });

  test('a behaviour that is emerging is not reported as fading', () => {
    const result = assessDrift(series([
      'counterexample', 'counterexample', 'counterexample', 'counterexample',
      'occurrence', 'occurrence', 'occurrence', 'occurrence',
    ]), policy);

    expect(result.shiftUp).toBe(true);
    expect(result.fading).toBe(false);
    expect(result.reasons).not.toContain('PATTERN_FADING');
  });

  test('reuses the formula engine EWMA and reports the smoothed series', () => {
    const result = assessDrift(
      series(['occurrence', 'occurrence', 'counterexample', 'counterexample']),
      policy,
    );
    expect(result.ewmaSeries).toHaveLength(4);
    // lambda = 0.3 starting at 1: 1, 1, 0.7, 0.49
    expect(result.ewmaSeries[0]).toBeCloseTo(1, 12);
    expect(result.ewmaSeries[2]).toBeCloseTo(0.7, 12);
    expect(result.ewmaSeries[3]).toBeCloseTo(0.49, 12);
    expect(result.ewmaLatest).toBeCloseTo(0.49, 12);
  });

  test('refuses without a ratified policy', () => {
    expect(() => assessDrift(series(['occurrence']), undefined as unknown as PatternInferencePolicy))
      .toThrow(/INFERENCE_POLICY_MISSING/);
  });

  test('a single session cannot be configured as a trend', () => {
    expect(() => assessDrift(series(['occurrence']), {
      ...policy,
      drift: { ...policy.drift, minimumHistorySessions: 1 },
    })).toThrow(/at least 2/);
  });
});
