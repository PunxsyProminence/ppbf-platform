import {
  assessObserverReliability,
  type ObserverReliabilityPolicy,
} from './reliability';
import type { BehaviourObservation } from '../types';

const policy: ObserverReliabilityPolicy = {
  policyVersion: 'reliability-policy-v0-test-not-ratified',
  ratifiedByAccountId: 'account-owner-1',
  ratifiedAt: '2026-01-01T00:00:00.000Z',
  minimumCoRatedItems: 4,
  minimumKappa: 0.6,
  maximumObserverDeviation: 0.3,
};

function rating(
  sessionId: string,
  observerAccountId: string,
  polarity: BehaviourObservation['polarity'],
): BehaviourObservation {
  return {
    observationId: `${sessionId}-${observerAccountId}`,
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    behaviourKey: 'drops_lead_hand_after_jab',
    sessionId,
    taskContextKey: 'task-mitts',
    taskConstraint: 'controlled',
    fatigueContext: 'fresh',
    observedAt: '2026-06-01T10:00:00.000Z',
    source: { type: 'coach_tag', quality: 'high', referenceId: `ref-${sessionId}` },
    observerAccountId,
    interpretation: 'human_observed',
    polarity,
    attribution: { target: 'athlete', certainty: 'probable' },
  };
}

/** Two coaches rate the same six sessions; `pattern` is their verdict pairs. */
function pairs(pattern: readonly [BehaviourObservation['polarity'], BehaviourObservation['polarity']][]) {
  return pattern.flatMap(([a, b], index) => [
    rating(`s${index}`, 'coach-a', a),
    rating(`s${index}`, 'coach-b', b),
  ]);
}

const OCC = 'occurrence' as const;
const CNT = 'counterexample' as const;

describe('observer reliability', () => {
  test('too little overlap is reported as unknown, not as disagreement', () => {
    const result = assessObserverReliability(pairs([[OCC, OCC], [CNT, CNT]]), policy);
    expect(result.verdict).toBe('insufficient_overlap');
    expect(result.kappa).toBeNull();
    expect(result.reasons).toContain('RELIABILITY_INSUFFICIENT_OVERLAP');
  });

  test('a single observer produces no co-rated items at all', () => {
    const solo = Array.from({ length: 6 }, (_, i) => rating(`s${i}`, 'coach-a', OCC));
    expect(assessObserverReliability(solo, policy).coRatedItems).toHaveLength(0);
  });

  test('perfect agreement with real variance is perfect reliability', () => {
    const result = assessObserverReliability(pairs([
      [OCC, OCC], [OCC, OCC], [CNT, CNT], [CNT, CNT],
    ]), policy);
    expect(result.observedAgreement).toBe(1);
    expect(result.chanceAgreement).toBeCloseTo(0.5, 12);
    expect(result.kappa).toBeCloseTo(1, 12);
    expect(result.verdict).toBe('reliable');
  });

  test('unanimous agreement with NO variance is not reliability', () => {
    // Every rating in the window is "occurrence". Raw agreement is 100% and
    // means nothing: these observers have not shown they can tell anything
    // apart. Reporting 1.0 here would let the least informative possible data
    // make the strongest possible claim.
    const result = assessObserverReliability(pairs([
      [OCC, OCC], [OCC, OCC], [OCC, OCC], [OCC, OCC], [OCC, OCC],
    ]), policy);

    expect(result.observedAgreement).toBe(1);
    expect(result.verdict).toBe('degenerate_no_variance');
    expect(result.kappa).toBeNull();
    expect(result.reasons).toContain('RELIABILITY_NO_VARIANCE');
  });

  test('chance-level agreement falls below policy', () => {
    const result = assessObserverReliability(pairs([
      [OCC, OCC], [OCC, CNT], [CNT, OCC], [OCC, CNT], [CNT, OCC], [OCC, OCC],
    ]), policy);

    expect(result.kappa).not.toBeNull();
    expect(result.kappa!).toBeLessThan(policy.minimumKappa);
    expect(result.verdict).toBe('below_policy');
    expect(result.reasons).toContain('RELIABILITY_KAPPA_BELOW_POLICY');
  });

  test('high agreement inflated by base rate is corrected, not credited', () => {
    // The coaches agree on 5 of 6 sessions -- 83% raw -- but almost everything
    // is tagged "occurrence", so most of that agreement is the base rate
    // rather than the coaches.
    const result = assessObserverReliability(pairs([
      [OCC, OCC], [OCC, OCC], [OCC, OCC], [OCC, OCC], [OCC, CNT], [OCC, OCC],
    ]), policy);

    expect(result.observedAgreement).toBeCloseTo(5 / 6, 12);
    expect(result.kappa!).toBeLessThan(result.observedAgreement!);
    expect(result.verdict).toBe('below_policy');
  });

  test('names an observer who is systematically out of step', () => {
    // coach-c disagrees with the other two on every session.
    const observations = ['s0', 's1', 's2', 's3'].flatMap((sessionId) => [
      rating(sessionId, 'coach-a', OCC),
      rating(sessionId, 'coach-b', OCC),
      rating(sessionId, 'coach-c', CNT),
    ]).concat(['s4', 's5'].flatMap((sessionId) => [
      rating(sessionId, 'coach-a', CNT),
      rating(sessionId, 'coach-b', CNT),
      rating(sessionId, 'coach-c', OCC),
    ]));

    const result = assessObserverReliability(observations, policy);
    const deviant = result.observerDeviations.filter((observer) => observer.systematicallyDeviant);

    expect(deviant).toHaveLength(1);
    expect(deviant[0].observerAccountId).toBe('coach-c');
    expect(deviant[0].deviationRate).toBe(1);
    expect(result.reasons).toContain('RELIABILITY_OBSERVER_DEVIANT');
    // The other two are not blamed for the third's behaviour.
    const steady = result.observerDeviations.find((o) => o.observerAccountId === 'coach-a');
    expect(steady?.systematicallyDeviant).toBe(false);
  });

  test('two disagreeing raters name nobody -- there is no consensus to defy', () => {
    // Symmetric by construction: whichever coach you call deviant, the same
    // argument convicts the other. Kappa still records the disagreement.
    const result = assessObserverReliability(pairs([
      [OCC, CNT], [OCC, CNT], [CNT, OCC], [CNT, OCC],
    ]), policy);
    expect(result.observerDeviations.every((o) => o.systematicallyDeviant === false)).toBe(true);
    expect(result.observerDeviations.every((o) => o.coRatedItems === 0)).toBe(true);
    expect(result.kappa!).toBeLessThan(0);
  });

  test('one observer tagging a session both ways casts no vote for it', () => {
    // coach-b logged one of each in s0: no verdict, so s0 is not co-rated.
    const observations = [
      rating('tie-session', 'coach-a', OCC),
      { ...rating('tie-session', 'coach-b', OCC), observationId: 'x1' },
      { ...rating('tie-session', 'coach-b', CNT), observationId: 'x2' },
      ...pairs([[OCC, OCC], [CNT, CNT], [OCC, OCC], [CNT, CNT]]),
    ];
    const result = assessObserverReliability(observations, policy);
    expect(result.coRatedItems.map((item) => item.sessionId)).not.toContain('tie-session');
  });

  test('is order-independent', () => {
    const observations = pairs([[OCC, OCC], [CNT, CNT], [OCC, CNT], [CNT, CNT]]);
    expect(assessObserverReliability(observations, policy).kappa)
      .toBe(assessObserverReliability([...observations].reverse(), policy).kappa);
  });

  test('refuses without a ratified policy', () => {
    expect(() => assessObserverReliability([], undefined as unknown as ObserverReliabilityPolicy))
      .toThrow(/RELIABILITY_POLICY_MISSING/);
  });

  test('refuses to measure agreement from a single session', () => {
    expect(() => assessObserverReliability([], { ...policy, minimumCoRatedItems: 1 }))
      .toThrow(/a coincidence, not a measurement/);
  });

  test('ships no default policy', async () => {
    const reliabilityModule = await import('./reliability');
    expect(Object.keys(reliabilityModule).some((n) => /DEFAULT|STANDARD|RECOMMENDED/i.test(n)))
      .toBe(false);
  });
});
