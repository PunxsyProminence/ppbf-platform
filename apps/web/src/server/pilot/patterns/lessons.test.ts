/**
 * Intervention -> human-reviewed outcome -> validated athlete lesson.
 *
 * The two cases the brief singles out are the last two in the main table:
 * an intervention that improves the drill it was trained in but does not
 * transfer must NOT validate, and one that transfers and retains must. The
 * rest guard the human-authority boundaries around them.
 */

import {
  assertAthleteLessonPolicy,
  assertLessonIsNotMethodology,
  evaluateValidatedAthleteLesson,
  type AthleteLessonPolicy,
} from './lessons';
import type {
  BehaviourObservation,
  InterventionOutcomeReview,
  PatternIntervention,
  PatternReasonCode,
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

const intervention: PatternIntervention = {
  interventionId: 'intervention-1',
  organizationId: ORG,
  athleteId: ATHLETE,
  behaviourKey: BEHAVIOUR,
  // A real, human-authorized row in pilot.shadow_decisions.
  decisionId: 'decision-1',
  startedAt: STARTED_AT,
  trainedTaskContextKey: 'task-mitts',
  description: 'Recall cue on the jab return, mitt work, three sessions per week.',
};

const reviewedOutcome: InterventionOutcomeReview = {
  outcomeId: 'outcome-1',
  interventionId: 'intervention-1',
  matchState: 'match',
  reviewedByAccountId: 'coach-a',
  reviewedAt: '2026-06-25T00:00:00.000Z',
};

function improvement(
  index: number,
  taskContextKey: string,
  observedAt: string,
  overrides: Partial<BehaviourObservation> = {},
): BehaviourObservation {
  return {
    observationId: `post-${index}`,
    organizationId: ORG,
    athleteId: ATHLETE,
    behaviourKey: BEHAVIOUR,
    sessionId: `session-post-${index}`,
    taskContextKey,
    taskConstraint: 'live',
    fatigueContext: 'moderate',
    observedAt,
    source: { type: 'coach_tag', quality: 'high', referenceId: `ref-post-${index}` },
    observerAccountId: 'coach-a',
    interpretation: 'human_observed',
    polarity: 'counterexample',
    attribution: { target: 'athlete', certainty: 'probable' },
    ...overrides,
  };
}

function evaluate(overrides: {
  intervention?: PatternIntervention | null;
  outcome?: InterventionOutcomeReview | null;
  postObservations?: readonly BehaviourObservation[];
  patternState?: Parameters<typeof evaluateValidatedAthleteLesson>[0]['patternState'];
} = {}) {
  return evaluateValidatedAthleteLesson({
    organizationId: ORG,
    athleteId: ATHLETE,
    behaviourKey: BEHAVIOUR,
    patternState: overrides.patternState ?? 'ESTABLISHED_IN_CONTEXT',
    intervention: overrides.intervention === undefined ? intervention : overrides.intervention,
    outcome: overrides.outcome === undefined ? reviewedOutcome : overrides.outcome,
    postObservations: overrides.postObservations ?? [],
    policy,
    asOf: AS_OF,
  });
}

describe('validated athlete lesson evaluation', () => {
  test('improvement only in the trained drill is training, not a lesson', () => {
    const result = evaluate({
      postObservations: [
        improvement(1, 'task-mitts', '2026-06-20T10:00:00.000Z'),
        improvement(2, 'task-mitts', '2026-06-24T10:00:00.000Z'),
      ],
    });

    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('NO_TRANSFER_EVIDENCE');
    expect(result.transfer.distinctTaskContexts).toBe(0);
  });

  test('improvement that transfers and retains validates', () => {
    const result = evaluate({
      postObservations: [
        // Untrained context -> transfer.
        improvement(1, 'task-sparring', '2026-06-18T10:00:00.000Z'),
        // 20 days after the intervention started -> past the retention window.
        improvement(2, 'task-sparring', '2026-06-21T10:00:00.000Z'),
        improvement(3, 'task-open-rounds', '2026-06-28T10:00:00.000Z'),
      ],
    });

    expect(result.blockers).toEqual([]);
    expect(result.eligible).toBe(true);
    expect(result.transfer.distinctTaskContexts).toBe(2);
    expect(result.retention.count).toBeGreaterThanOrEqual(1);
    expect(result.retention.windowElapsed).toBe(true);
  });

  test('a lesson is athlete-scoped and never generalizes itself', () => {
    const result = evaluate({
      postObservations: [
        improvement(1, 'task-sparring', '2026-06-21T10:00:00.000Z'),
      ],
    });

    expect(result.scope).toBe('athlete_specific');
    expect(result.generalizableToMethodology).toBe(false);
    expect(result.humanReviewRequired).toBe(true);
    expect(() => assertLessonIsNotMethodology(result)).toThrow(/cannot be promoted to PPBF methodology/);
  });

  test.each<{ name: string; blocker: PatternReasonCode; build: () => ReturnType<typeof evaluate> }>([
    {
      name: 'an intervention nobody authorized cannot validate anything',
      blocker: 'INTERVENTION_NOT_HUMAN_AUTHORIZED',
      build: () => evaluate({
        intervention: { ...intervention, decisionId: null },
        postObservations: [improvement(1, 'task-sparring', '2026-06-21T10:00:00.000Z')],
      }),
    },
    {
      name: 'an unreviewed outcome cannot validate anything',
      blocker: 'OUTCOME_NOT_HUMAN_REVIEWED',
      build: () => evaluate({
        outcome: { ...reviewedOutcome, reviewedByAccountId: null, reviewedAt: null },
        postObservations: [improvement(1, 'task-sparring', '2026-06-21T10:00:00.000Z')],
      }),
    },
    {
      name: 'a confounded outcome states that something else changed too',
      blocker: 'OUTCOME_CONFOUNDED',
      build: () => evaluate({
        outcome: { ...reviewedOutcome, matchState: 'confounded' },
        postObservations: [improvement(1, 'task-sparring', '2026-06-21T10:00:00.000Z')],
      }),
    },
    {
      name: 'a missed outcome validates nothing',
      blocker: 'OUTCOME_MISS',
      build: () => evaluate({
        outcome: { ...reviewedOutcome, matchState: 'miss' },
        postObservations: [improvement(1, 'task-sparring', '2026-06-21T10:00:00.000Z')],
      }),
    },
    {
      name: 'a lesson cannot outrun the pattern it came from',
      blocker: 'NO_OBSERVATIONS',
      build: () => evaluate({
        patternState: 'CONTINUE_OBSERVING',
        postObservations: [improvement(1, 'task-sparring', '2026-06-21T10:00:00.000Z')],
      }),
    },
    {
      name: 'the behaviour returning in the trained context is regression',
      blocker: 'POST_INTERVENTION_REGRESSION',
      build: () => evaluate({
        postObservations: [
          improvement(1, 'task-sparring', '2026-06-21T10:00:00.000Z'),
          improvement(2, 'task-mitts', '2026-06-26T10:00:00.000Z', { polarity: 'occurrence' }),
        ],
      }),
    },
  ])('$name', ({ blocker, build }) => {
    const result = build();
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain(blocker);
  });

  test('retention not yet testable is distinguished from retention tested and absent', () => {
    const tooEarly = evaluateValidatedAthleteLesson({
      organizationId: ORG,
      athleteId: ATHLETE,
      behaviourKey: BEHAVIOUR,
      patternState: 'ESTABLISHED_IN_CONTEXT',
      intervention,
      outcome: reviewedOutcome,
      postObservations: [improvement(1, 'task-sparring', '2026-06-03T10:00:00.000Z')],
      policy,
      // Four days after the intervention: the 14-day window has not elapsed.
      asOf: '2026-06-05T00:00:00.000Z',
    });
    expect(tooEarly.blockers).toContain('RETENTION_WINDOW_NOT_ELAPSED');
    expect(tooEarly.blockers).not.toContain('NO_RETENTION_EVIDENCE');
    expect(tooEarly.retention.windowElapsed).toBe(false);

    const testedAndAbsent = evaluate({
      // Improvement only inside the window; nothing survived past day 14.
      postObservations: [improvement(1, 'task-sparring', '2026-06-03T10:00:00.000Z')],
    });
    expect(testedAndAbsent.retention.windowElapsed).toBe(true);
    expect(testedAndAbsent.blockers).toContain('NO_RETENTION_EVIDENCE');
    expect(testedAndAbsent.blockers).not.toContain('RETENTION_WINDOW_NOT_ELAPSED');
  });

  test('absence of observations is not improvement', () => {
    // Nobody recorded anything after the intervention. That is silence, and
    // silence must not read as success.
    const result = evaluate({ postObservations: [] });
    expect(result.eligible).toBe(false);
    expect(result.blockers).toContain('NO_TRANSFER_EVIDENCE');
    expect(result.blockers).toContain('NO_RETENTION_EVIDENCE');
  });
});

describe('athlete lesson policy guardrails', () => {
  test('human review of an outcome cannot be switched off by configuration', () => {
    expect(() => assertAthleteLessonPolicy({
      ...policy,
      requireHumanReviewedOutcome: false as unknown as true,
    })).toThrow(/cannot be disabled/);
  });

  test('confounded and missed outcomes cannot be configured as acceptable', () => {
    expect(() => assertAthleteLessonPolicy({
      ...policy,
      acceptedMatchStates: ['match', 'confounded'],
    })).toThrow(/confounded/);
    expect(() => assertAthleteLessonPolicy({
      ...policy,
      acceptedMatchStates: ['match', 'miss'],
    })).toThrow(/miss/);
  });

  test('a validation bar must be attributable to a person', () => {
    expect(() => assertAthleteLessonPolicy({ ...policy, ratifiedByAccountId: '  ' }))
      .toThrow(/attributable to a person/);
  });

  test('transfer and retention bars cannot be trivialised', () => {
    expect(() => assertAthleteLessonPolicy({ ...policy, minimumTransferContexts: 0 }))
      .toThrow(/is not transfer/);
    expect(() => assertAthleteLessonPolicy({ ...policy, retentionWindowDays: 0 }))
      .toThrow(/is not retention/);
  });
});
