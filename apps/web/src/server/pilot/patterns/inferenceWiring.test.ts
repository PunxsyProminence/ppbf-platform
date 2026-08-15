/**
 * Phase A wired into the §337 adversarial ladder.
 *
 * The central safety property is MONOTONICITY: turning inference on may add
 * blockers and may not remove any. A candidate the rules refused stays
 * refused, whatever the statistics say. Anything else would let a model fitted
 * to one gym's history overrule stated methodology.
 */

import { evaluatePatternCandidate } from './promotion';
import type { PatternFormationPolicy } from './policy';
import type { PatternInferencePolicy } from './inference/policy';
import type { BehaviourObservation } from './types';

const ORG = 'org-1';
const ATHLETE = 'athlete-1';
const BEHAVIOUR = 'drops_lead_hand_after_jab';
const AS_OF = '2026-07-01T00:00:00.000Z';

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

const inferencePolicy: PatternInferencePolicy = {
  policyVersion: 'inference-policy-v0-test-not-ratified',
  ratifiedByAccountId: 'account-owner-1',
  ratifiedAt: '2026-01-01T00:00:00.000Z',
  recurrencePrior: { priorOccurrences: 1, priorNonOccurrences: 3 },
  sequentialTest: { nullRate: 0.2, alternativeRate: 0.6, falsePromotionRate: 0.05, missedPatternRate: 0.2 },
  posteriorWidth: { credibleMass: 0.9, maximumCredibleWidth: 0.4 },
  stratifiedAttribution: { concentration: 1, minimumStratumSize: 2 },
  drift: { ewmaLambda: 0.3, cusumSlack: 0.1, cusumThreshold: 0.4, minimumHistorySessions: 3 },
};

function obs(index: number, overrides: Partial<BehaviourObservation> = {}): BehaviourObservation {
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

/** Clears the §337 rules on every dimension, but only four observations deep. */
function strongEvidence(): BehaviourObservation[] {
  return [
    obs(1, { sessionId: 's1', taskContextKey: 'task-mitts', taskConstraint: 'controlled', fatigueContext: 'fresh', observerAccountId: 'coach-a' }),
    obs(2, { sessionId: 's2', taskContextKey: 'task-mitts', taskConstraint: 'controlled', fatigueContext: 'fatigued', observerAccountId: 'coach-b' }),
    obs(3, { sessionId: 's3', taskContextKey: 'task-sparring', taskConstraint: 'live', fatigueContext: 'fresh', observerAccountId: 'coach-a' }),
    obs(4, { sessionId: 's3', taskContextKey: 'task-sparring', taskConstraint: 'live', fatigueContext: 'fatigued', observerAccountId: 'coach-b' }),
  ];
}

/** The same behaviour, watched long enough for the posterior to narrow. */
function overwhelmingEvidence(): BehaviourObservation[] {
  return Array.from({ length: 20 }, (_, i) => obs(i + 1, {
    sessionId: `s${i + 1}`,
    taskContextKey: i % 2 === 0 ? 'task-mitts' : 'task-sparring',
    taskConstraint: i % 2 === 0 ? 'controlled' : 'live',
    fatigueContext: i % 3 === 0 ? 'fatigued' : 'fresh',
    observerAccountId: i % 2 === 0 ? 'coach-a' : 'coach-b',
    observedAt: `2026-06-${String((i % 28) + 1).padStart(2, '0')}T10:00:00.000Z`,
  }));
}

function evaluate(observations: readonly BehaviourObservation[], withInference: boolean, previouslyEstablished = false) {
  return evaluatePatternCandidate({
    organizationId: ORG,
    athleteId: ATHLETE,
    behaviourKey: BEHAVIOUR,
    observations,
    policy: rules,
    asOf: AS_OF,
    previouslyEstablished,
    ...(withInference ? { inferencePolicy } : {}),
  });
}

describe('Phase A wiring', () => {
  test('inference is absent unless a policy is supplied', () => {
    expect(evaluate(strongEvidence(), false).inference).toBeNull();
    expect(evaluate(strongEvidence(), true).inference).not.toBeNull();
  });

  test('inference only ever adds blockers, never removes one', () => {
    const scenarios: readonly BehaviourObservation[][] = [
      [obs(1)],
      [obs(1, { polarity: 'counterexample' }), obs(2, { polarity: 'counterexample' })],
      strongEvidence(),
      overwhelmingEvidence(),
      strongEvidence().map((o) => ({ ...o, fatigueContext: 'fatigued' as const })),
      strongEvidence().map((o) => ({ ...o, attribution: { target: 'coach_cue' as const, certainty: 'probable' as const } })),
      strongEvidence().map((o) => ({ ...o, observerAccountId: 'coach-a' })),
    ];

    for (const observations of scenarios) {
      const without = evaluate(observations, false);
      const withIt = evaluate(observations, true);
      for (const blocker of without.blockers) {
        expect(withIt.blockers).toContain(blocker);
      }
      // And promotion can never be created by inference.
      if (without.promotion === null) {
        expect(withIt.promotion).toBeNull();
      }
    }
  });

  test('four observations clear the rules but leave the posterior too wide', () => {
    // The §6 acceptance case, at integration level: the rules are satisfied,
    // and the statistics say we still do not know the rate.
    const withoutInference = evaluate(strongEvidence(), false);
    expect(withoutInference.state).toBe('ESTABLISHED_IN_CONTEXT');

    const withInference = evaluate(strongEvidence(), true);
    expect(withInference.state).toBe('CONTINUE_OBSERVING');
    expect(withInference.blockers).toContain('POSTERIOR_TOO_WIDE');
    expect(withInference.promotion).toBeNull();
  });

  test('enough evidence satisfies both the rules and the statistics', () => {
    const result = evaluate(overwhelmingEvidence(), true);
    expect(result.blockers).toEqual([]);
    expect(result.state).toBe('ESTABLISHED_IN_CONTEXT');
    expect(result.promotion?.requiresHumanAuthorization).toBe(true);
  });

  test('a fatigue-confined behaviour is attributed to load, not the athlete', () => {
    // Occurrences only when fatigued; the athlete does it right when fresh.
    //
    // Counterexamples are kept below counterEvidenceContestRatio and the two
    // groups are interleaved in time, so neither CONTESTED nor PATTERN_FADING
    // fires. Both would be legitimate abstentions, but they precede
    // attribution and would mask the property under test.
    const observations = [
      ...Array.from({ length: 12 }, (_, i) => obs(i + 1, {
        sessionId: `sf${i}`, fatigueContext: 'fatigued',
        taskContextKey: i % 2 === 0 ? 'task-mitts' : 'task-sparring',
        taskConstraint: i % 2 === 0 ? 'controlled' : 'live',
        observerAccountId: i % 2 === 0 ? 'coach-a' : 'coach-b',
        observedAt: `2026-06-${String((2 * i) + 1).padStart(2, '0')}T10:00:00.000Z`,
      })),
      ...Array.from({ length: 5 }, (_, i) => obs(i + 13, {
        sessionId: `sr${i}`, fatigueContext: 'fresh', polarity: 'counterexample',
        taskContextKey: i % 2 === 0 ? 'task-mitts' : 'task-sparring',
        taskConstraint: i % 2 === 0 ? 'controlled' : 'live',
        observerAccountId: i % 2 === 0 ? 'coach-a' : 'coach-b',
        observedAt: `2026-06-${String((4 * i) + 2).padStart(2, '0')}T10:00:00.000Z`,
      })),
    ];

    const result = evaluate(observations, true);
    expect(result.blockers).toContain('LOAD_STRATUM_IMPLICATED');
    expect(result.state).toBe('ATTRIBUTION_UNRESOLVED');
  });

  test('a charted decline retires an established pattern', () => {
    const observations = [
      ...Array.from({ length: 6 }, (_, i) => obs(i + 1, {
        sessionId: `sa${i}`,
        taskContextKey: i % 2 === 0 ? 'task-mitts' : 'task-sparring',
        taskConstraint: i % 2 === 0 ? 'controlled' : 'live',
        fatigueContext: i % 2 === 0 ? 'fresh' : 'fatigued',
        observerAccountId: i % 2 === 0 ? 'coach-a' : 'coach-b',
        observedAt: `2026-06-0${i + 1}T10:00:00.000Z`,
      })),
      ...Array.from({ length: 6 }, (_, i) => obs(i + 7, {
        sessionId: `sb${i}`, polarity: 'counterexample',
        taskContextKey: i % 2 === 0 ? 'task-mitts' : 'task-sparring',
        taskConstraint: i % 2 === 0 ? 'controlled' : 'live',
        fatigueContext: i % 2 === 0 ? 'fresh' : 'fatigued',
        observerAccountId: i % 2 === 0 ? 'coach-a' : 'coach-b',
        observedAt: `2026-06-1${i + 1}T10:00:00.000Z`,
      })),
    ];

    const result = evaluate(observations, true, true);
    expect(result.blockers).toContain('PATTERN_FADING');
    // Contested wins on precedence here -- counterexamples rival occurrences --
    // which is itself the right answer; either way it does not promote.
    expect(['RETIRED', 'CONTESTED']).toContain(result.state);
    expect(result.promotion).toBeNull();
  });

  test('the sequential verdict rides on the existing state, not a parallel one', () => {
    const result = evaluate(strongEvidence(), true);
    const report = result.inference as { recurrence: { verdict: string } };
    // SPRT says promote; the posterior width still blocks. The candidate has
    // exactly one state, and it is one of the §337 states.
    expect(report.recurrence.verdict).toBe('promote');
    expect(result.state).toBe('CONTINUE_OBSERVING');
    expect(result).not.toHaveProperty('inferenceState');
  });

  test('every evaluation still requires human review', () => {
    for (const withInference of [false, true]) {
      expect(evaluate(overwhelmingEvidence(), withInference).humanReviewRequired).toBe(true);
    }
  });
});
