/**
 * The case counting cannot see.
 *
 * Both scenarios below produce IDENTICAL post-intervention evidence: the same
 * sessions, the same contexts, the same clean run of counterexamples. The
 * counting rules in `lessons.ts` validate both, because from where they stand
 * the two are the same lesson.
 *
 * They differ only in what was happening BEFORE anyone intervened. In one the
 * athlete was steady; in the other they were already fixing it on their own.
 * Validating the second would put "this cue works" in the record on the
 * strength of a trend that predates the cue -- and that record is what the
 * next kid gets coached from.
 */

import { evaluateValidatedAthleteLesson, type AthleteLessonPolicy } from './lessons';
import type { SingleCaseDesignPolicy } from './inference/singleCase';
import type {
  BehaviourObservation,
  InterventionOutcomeReview,
  PatternIntervention,
} from './types';

const ORG = 'org-1';
const ATHLETE = 'athlete-1';
const BEHAVIOUR = 'drops_lead_hand_after_jab';
const STARTED_AT = '2026-06-01T00:00:00.000Z';
const AS_OF = '2026-07-01T00:00:00.000Z';

const policy: AthleteLessonPolicy = {
  policyVersion: 'lesson-policy-v0-test-not-ratified',
  ratifiedByAccountId: 'account-owner-1',
  ratifiedAt: '2026-01-01T00:00:00.000Z',
  minimumTransferContexts: 1,
  retentionWindowDays: 14,
  minimumRetentionObservations: 1,
  requireHumanReviewedOutcome: true,
  acceptedMatchStates: ['match', 'partial'],
};

const scdPolicy: SingleCaseDesignPolicy = {
  policyVersion: 'scd-policy-v0-test-not-ratified',
  ratifiedByAccountId: 'account-owner-1',
  ratifiedAt: '2026-01-01T00:00:00.000Z',
  minimumBaselineObservations: 4,
  minimumTreatmentObservations: 4,
  minimumNonoverlap: 0.7,
  maximumBaselineTrend: 0.5,
  significanceLevel: 0.05,
};

const intervention: PatternIntervention = {
  interventionId: 'intervention-1',
  organizationId: ORG,
  athleteId: ATHLETE,
  behaviourKey: BEHAVIOUR,
  decisionId: 'decision-1',
  startedAt: STARTED_AT,
  trainedTaskContextKey: 'task-mitts',
  description: 'Recall cue on the jab return, mitt work, three sessions per week.',
};

const outcome: InterventionOutcomeReview = {
  outcomeId: 'outcome-1',
  interventionId: 'intervention-1',
  matchState: 'match',
  reviewedByAccountId: 'coach-a',
  reviewedAt: '2026-06-25T00:00:00.000Z',
};

function observation(
  id: string,
  sessionId: string,
  observedAt: string,
  polarity: BehaviourObservation['polarity'],
  taskContextKey = 'task-mitts',
): BehaviourObservation {
  return {
    observationId: id,
    organizationId: ORG,
    athleteId: ATHLETE,
    behaviourKey: BEHAVIOUR,
    sessionId,
    taskContextKey,
    taskConstraint: 'live',
    fatigueContext: 'moderate',
    observedAt,
    source: { type: 'coach_tag', quality: 'high', referenceId: `ref-${id}` },
    observerAccountId: 'coach-a',
    interpretation: 'human_observed',
    polarity,
    attribution: { target: 'athlete', certainty: 'probable' },
  };
}

/** One pre-intervention session of four reps, `occurrences` of them faulty. */
function baselineSession(index: number, day: number, occurrences: number): BehaviourObservation[] {
  return Array.from({ length: 4 }, (_, rep) => observation(
    `pre-${index}-${rep}`,
    `session-pre-${index}`,
    `2026-05-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    rep < occurrences ? 'occurrence' : 'counterexample',
  ));
}

/** Steady at 4/4 faulty across five sessions: no trend to mistake for an effect. */
const steadyBaseline = [
  ...baselineSession(1, 4, 4),
  ...baselineSession(2, 8, 4),
  ...baselineSession(3, 12, 4),
  ...baselineSession(4, 16, 4),
  ...baselineSession(5, 20, 4),
];

/** Already fixing it: 4/4 faulty down to 0/4 before the intervention began. */
const improvingBaseline = [
  ...baselineSession(1, 4, 4),
  ...baselineSession(2, 8, 3),
  ...baselineSession(3, 12, 2),
  ...baselineSession(4, 16, 1),
  ...baselineSession(5, 20, 0),
];

/** Identical in both scenarios: transfers to two untrained contexts, retains. */
const postObservations = [
  observation('post-1', 'session-post-1', '2026-06-18T10:00:00.000Z', 'counterexample', 'task-sparring'),
  observation('post-2', 'session-post-2', '2026-06-21T10:00:00.000Z', 'counterexample', 'task-sparring'),
  observation('post-3', 'session-post-3', '2026-06-24T10:00:00.000Z', 'counterexample', 'task-open-rounds'),
  observation('post-4', 'session-post-4', '2026-06-27T10:00:00.000Z', 'counterexample', 'task-open-rounds'),
  observation('post-5', 'session-post-5', '2026-06-30T10:00:00.000Z', 'counterexample', 'task-sparring'),
];

function evaluate(preObservations?: readonly BehaviourObservation[]) {
  return evaluateValidatedAthleteLesson({
    organizationId: ORG,
    athleteId: ATHLETE,
    behaviourKey: BEHAVIOUR,
    patternState: 'ESTABLISHED_IN_CONTEXT',
    intervention,
    outcome,
    postObservations,
    policy,
    asOf: AS_OF,
    ...(preObservations
      ? { preObservations, singleCaseDesignPolicy: scdPolicy, improvementDirection: 'decrease' as const }
      : {}),
  });
}

describe('single-case design inside the lesson gate', () => {
  test('counting alone validates the lesson, baseline unseen', () => {
    const result = evaluate();
    expect(result.blockers).toEqual([]);
    expect(result.eligible).toBe(true);
    expect(result.singleCase).toBeNull();
  });

  test('a steady baseline supports the effect and the lesson still validates', () => {
    const result = evaluate(steadyBaseline);
    const scd = result.singleCase as { verdict: string; nonoverlap: { nap: number }; exactP: number };

    expect(scd.verdict).toBe('effect_supported');
    expect(scd.nonoverlap.nap).toBe(1);
    expect(scd.exactP).toBeCloseTo(1 / 252, 12);
    expect(result.blockers).toEqual([]);
    expect(result.eligible).toBe(true);
  });

  test('an already-improving baseline blocks the same lesson', () => {
    const result = evaluate(improvingBaseline);
    const scd = result.singleCase as { verdict: string; baselineTrend: number; nonoverlap: { nap: number } };

    // Nonoverlap is 0.9 -- comfortably past the 0.7 policy bar, and short of 1
    // only because the last pre-intervention session had already reached zero.
    // On nonoverlap alone this lesson validates.
    expect(scd.nonoverlap.nap).toBe(0.9);
    expect(scd.nonoverlap.nap).toBeGreaterThan(scdPolicy.minimumNonoverlap);
    // The baseline check is the only thing standing in the way, and it is
    // standing in the way for the right reason: the athlete was already on
    // their way down before the cue existed.
    expect(scd.baselineTrend).toBe(-1);
    expect(scd.verdict).toBe('baseline_unstable');
    expect(result.blockers).toContain('SCD_BASELINE_UNSTABLE');
    expect(result.eligible).toBe(false);
  });

  test('the two scenarios are distinguishable ONLY by the baseline', () => {
    // Guards the premise of the test above: if the post-evidence ever diverges,
    // the comparison stops proving what it claims to prove.
    const steady = evaluate(steadyBaseline);
    const improving = evaluate(improvingBaseline);
    expect(steady.transfer).toEqual(improving.transfer);
    expect(steady.retention).toEqual(improving.retention);
    expect(steady.outcomeMatchState).toEqual(improving.outcomeMatchState);
  });

  test('single-case design can only add blockers, never clear one', () => {
    const withoutScd = evaluateValidatedAthleteLesson({
      organizationId: ORG,
      athleteId: ATHLETE,
      behaviourKey: BEHAVIOUR,
      patternState: 'CONTINUE_OBSERVING',
      intervention,
      outcome,
      postObservations,
      policy,
      asOf: AS_OF,
    });
    const withScd = evaluateValidatedAthleteLesson({
      organizationId: ORG,
      athleteId: ATHLETE,
      behaviourKey: BEHAVIOUR,
      patternState: 'CONTINUE_OBSERVING',
      intervention,
      outcome,
      postObservations,
      policy,
      asOf: AS_OF,
      preObservations: steadyBaseline,
      singleCaseDesignPolicy: scdPolicy,
      improvementDirection: 'decrease',
    });

    // A perfect effect does not rescue a lesson drawn from an unestablished
    // pattern. Every blocker survives.
    for (const blocker of withoutScd.blockers) {
      expect(withScd.blockers).toContain(blocker);
    }
    expect(withScd.eligible).toBe(false);
  });

  test('an SCD policy with no baseline is refused, not silently skipped', () => {
    expect(() => evaluateValidatedAthleteLesson({
      organizationId: ORG,
      athleteId: ATHLETE,
      behaviourKey: BEHAVIOUR,
      patternState: 'ESTABLISHED_IN_CONTEXT',
      intervention,
      outcome,
      postObservations,
      policy,
      asOf: AS_OF,
      singleCaseDesignPolicy: scdPolicy,
    })).toThrow(/not a comparison/);
  });

  test('human review remains required either way', () => {
    expect(evaluate().humanReviewRequired).toBe(true);
    expect(evaluate(steadyBaseline).humanReviewRequired).toBe(true);
  });
});
