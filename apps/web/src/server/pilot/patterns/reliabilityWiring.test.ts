/**
 * Observer reliability inside the promotion ladder.
 *
 * The ladder already requires two observers. This asks the question that
 * requirement was standing in for: do the two agree? A pattern that four
 * coaches saw, who agree with each other at chance, is a fact about the
 * tagging, not about the athlete.
 */

import { evaluatePatternCandidate } from './promotion';
import type { PatternFormationPolicy } from './policy';
import type { ObserverReliabilityPolicy } from './inference/reliability';
import type { BehaviourObservation } from './types';

const ORG = 'org-1';
const ATHLETE = 'athlete-1';
const BEHAVIOUR = 'drops_lead_hand_after_jab';

const rules: PatternFormationPolicy = {
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

const reliabilityPolicy: ObserverReliabilityPolicy = {
  policyVersion: 'reliability-policy-v0-test-not-ratified',
  ratifiedByAccountId: 'account-owner-1',
  ratifiedAt: '2026-01-01T00:00:00.000Z',
  minimumCoRatedItems: 4,
  minimumKappa: 0.6,
  maximumObserverDeviation: 0.3,
};

function obs(
  id: string,
  sessionId: string,
  observerAccountId: string,
  polarity: BehaviourObservation['polarity'],
  index: number,
): BehaviourObservation {
  return {
    observationId: id,
    organizationId: ORG,
    athleteId: ATHLETE,
    behaviourKey: BEHAVIOUR,
    sessionId,
    taskContextKey: index % 2 === 0 ? 'task-mitts' : 'task-sparring',
    taskConstraint: index % 2 === 0 ? 'controlled' : 'live',
    fatigueContext: index % 2 === 0 ? 'fresh' : 'fatigued',
    observedAt: `2026-06-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`,
    source: { type: 'coach_tag', quality: 'high', referenceId: `ref-${id}` },
    observerAccountId,
    interpretation: 'human_observed',
    polarity,
    attribution: { target: 'athlete', certainty: 'probable' },
  };
}

/** Six sessions, two coaches each. `agree` decides whether they match. */
function corpus(agree: boolean): BehaviourObservation[] {
  return Array.from({ length: 6 }, (_, i) => {
    const primary = i < 4 ? 'occurrence' : 'counterexample';
    const secondary = agree
      ? primary
      : (i % 2 === 0 ? 'occurrence' : 'counterexample');
    return [
      obs(`a-${i}`, `s${i}`, 'coach-a', primary as BehaviourObservation['polarity'], i),
      obs(`b-${i}`, `s${i}`, 'coach-b', secondary as BehaviourObservation['polarity'], i),
    ];
  }).flat();
}

function evaluate(observations: readonly BehaviourObservation[], withReliability: boolean) {
  return evaluatePatternCandidate({
    organizationId: ORG,
    athleteId: ATHLETE,
    behaviourKey: BEHAVIOUR,
    observations,
    policy: rules,
    asOf: '2026-07-01T00:00:00.000Z',
    ...(withReliability ? { observerReliabilityPolicy: reliabilityPolicy } : {}),
  });
}

describe('observer reliability wiring', () => {
  test('reliability is absent unless a policy is supplied', () => {
    expect(evaluate(corpus(true), false).reliability).toBeNull();
    expect(evaluate(corpus(true), true).reliability).not.toBeNull();
  });

  test('coaches who agree do not block the candidate', () => {
    const result = evaluate(corpus(true), true);
    const report = result.reliability as { verdict: string; kappa: number };
    expect(report.verdict).toBe('reliable');
    expect(report.kappa).toBeCloseTo(1, 12);
    expect(result.blockers).not.toContain('MEASUREMENT_UNRELIABLE');
  });

  test('coaches who agree at chance block it, however many observations there are', () => {
    const result = evaluate(corpus(false), true);
    expect(result.blockers).toContain('MEASUREMENT_UNRELIABLE');
    expect(result.promotion).toBeNull();
  });

  test('unmeasured reliability blocks as firmly as bad reliability', () => {
    // Two co-rated sessions is below the policy floor: nobody can say whether
    // these coaches see the same thing. Unknown is not permission.
    const thin = corpus(true).filter((item) => ['s0', 's1'].includes(item.sessionId));
    const result = evaluate(thin, true);
    expect(result.blockers).toContain('MEASUREMENT_RELIABILITY_UNKNOWN');
  });

  test('reliability only ever adds blockers', () => {
    for (const observations of [corpus(true), corpus(false), []]) {
      const without = evaluate(observations, false);
      const withIt = evaluate(observations, true);
      for (const blocker of without.blockers) {
        expect(withIt.blockers).toContain(blocker);
      }
      if (without.promotion === null) expect(withIt.promotion).toBeNull();
    }
  });

  test('human review remains required either way', () => {
    expect(evaluate(corpus(true), true).humanReviewRequired).toBe(true);
  });
});
