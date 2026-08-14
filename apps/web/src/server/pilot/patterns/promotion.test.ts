/**
 * Adversarial/golden harness for the observation -> pattern ladder.
 *
 * Each case below is a coaching situation that a naive "count the
 * observations" implementation gets wrong. The expected result is very often
 * an abstention, and that is the point: the suite asserts that the algorithm
 * REFUSES in the situations where refusing is correct, not merely that it
 * promotes in the one situation where promoting is.
 *
 * The policy used here is a TEST policy. It is not a ratified PPBF bar and
 * its numbers carry no scientific claim -- they exist so the cases have
 * something to be judged against. Ratifying a real bar is owner authority.
 */

import { evaluatePatternCandidate } from './promotion';
import type { PatternFormationPolicy } from './policy';
import type {
  BehaviourObservation,
  PatternEpistemicState,
  PatternReasonCode,
} from './types';

const ORG = 'org-1';
const ATHLETE = 'athlete-1';
const BEHAVIOUR = 'drops_lead_hand_after_jab';
const AS_OF = '2026-07-01T00:00:00.000Z';

const policy: PatternFormationPolicy = {
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

function day(index: number, month = 6): string {
  return `2026-${String(month).padStart(2, '0')}-${String(index).padStart(2, '0')}T10:00:00.000Z`;
}

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
    observedAt: day(index),
    source: { type: 'coach_tag', quality: 'high', referenceId: `ref-${index}` },
    observerAccountId: 'coach-a',
    interpretation: 'human_observed',
    polarity: 'occurrence',
    attribution: { target: 'athlete', certainty: 'probable' },
    ...overrides,
  };
}

/**
 * Evidence strong enough to clear the test policy on every dimension: four
 * occurrences, three sessions, two task contexts, two observers, controlled
 * and live, mixed fatigue, all attributed to the athlete, no counterexamples.
 * Individual cases mutate one dimension of this to isolate one failure mode.
 */
function strongEvidence(): BehaviourObservation[] {
  return [
    obs(1, { sessionId: 'session-1', taskContextKey: 'task-mitts', taskConstraint: 'controlled', fatigueContext: 'fresh', observerAccountId: 'coach-a' }),
    obs(2, { sessionId: 'session-2', taskContextKey: 'task-mitts', taskConstraint: 'controlled', fatigueContext: 'fatigued', observerAccountId: 'coach-b' }),
    obs(3, { sessionId: 'session-3', taskContextKey: 'task-sparring', taskConstraint: 'live', fatigueContext: 'fresh', observerAccountId: 'coach-a' }),
    obs(4, { sessionId: 'session-3', taskContextKey: 'task-sparring', taskConstraint: 'live', fatigueContext: 'fatigued', observerAccountId: 'coach-b' }),
  ];
}

interface Case {
  readonly name: string;
  readonly observations: readonly BehaviourObservation[];
  readonly previouslyEstablished?: boolean;
  readonly expectedState: PatternEpistemicState;
  readonly expectedBlockers: readonly PatternReasonCode[];
}

const cases: readonly Case[] = [
  {
    name: 'one bad rep is not a pattern',
    observations: [obs(1)],
    expectedState: 'INSUFFICIENT_EVIDENCE',
    expectedBlockers: ['SINGLE_OBSERVATION'],
  },
  {
    name: 'one spectacular success is not a pattern either',
    // Same shape as the bad rep, positive behaviour. The ladder is not biased
    // toward failure: a single brilliant rep buys no overlay either.
    observations: [obs(1, { behaviourKey: BEHAVIOUR, note: 'best counter of the year' })],
    expectedState: 'INSUFFICIENT_EVIDENCE',
    expectedBlockers: ['SINGLE_OBSERVATION'],
  },
  {
    name: 'only counterexamples means there is no occurrence to explain',
    observations: [
      obs(1, { polarity: 'counterexample' }),
      obs(2, { polarity: 'counterexample' }),
    ],
    expectedState: 'INSUFFICIENT_EVIDENCE',
    expectedBlockers: ['NO_OBSERVATIONS'],
  },
  {
    name: 'repeated in exactly one drill stays a one-drill artefact',
    observations: [
      obs(1, { sessionId: 'session-1', taskContextKey: 'task-mitts', observerAccountId: 'coach-a', fatigueContext: 'fresh' }),
      obs(2, { sessionId: 'session-2', taskContextKey: 'task-mitts', observerAccountId: 'coach-b', fatigueContext: 'fatigued' }),
      obs(3, { sessionId: 'session-3', taskContextKey: 'task-mitts', observerAccountId: 'coach-a', fatigueContext: 'fresh' }),
      obs(4, { sessionId: 'session-4', taskContextKey: 'task-mitts', observerAccountId: 'coach-b', fatigueContext: 'fatigued' }),
    ],
    expectedState: 'SINGLE_CONTEXT_ONLY',
    expectedBlockers: ['SINGLE_TASK_CONTEXT', 'BELOW_POLICY_TASK_CONTEXTS'],
  },
  {
    name: 'genuinely repeated across contexts, observers and constraints is proposable',
    observations: strongEvidence(),
    expectedState: 'ESTABLISHED_IN_CONTEXT',
    expectedBlockers: [],
  },
  {
    name: 'fatigue-only breakdown is a claim about fatigue, not about the athlete',
    observations: strongEvidence().map((observation) => ({ ...observation, fatigueContext: 'fatigued' as const })),
    expectedState: 'CONTINUE_OBSERVING',
    expectedBlockers: ['FATIGUE_CONTEXT_ONLY'],
  },
  {
    name: 'behaviour disappears when the task is simplified',
    observations: [
      obs(1, { sessionId: 'session-1', taskContextKey: 'task-complex-combo', taskConstraint: 'live', observerAccountId: 'coach-a' }),
      obs(2, { sessionId: 'session-2', taskContextKey: 'task-complex-combo', taskConstraint: 'live', observerAccountId: 'coach-b' }),
      obs(3, { sessionId: 'session-3', taskContextKey: 'task-complex-defence', taskConstraint: 'controlled', observerAccountId: 'coach-a' }),
      obs(4, { sessionId: 'session-4', taskContextKey: 'task-complex-defence', taskConstraint: 'controlled', observerAccountId: 'coach-b' }),
      // Simplify the task and the behaviour stops. That is evidence about the
      // task, and it must not be filed as evidence about the athlete.
      obs(5, { sessionId: 'session-5', taskContextKey: 'task-single-jab', polarity: 'counterexample', observerAccountId: 'coach-a' }),
      obs(6, { sessionId: 'session-6', taskContextKey: 'task-single-jab', polarity: 'counterexample', observerAccountId: 'coach-b' }),
    ],
    expectedState: 'CONTESTED',
    expectedBlockers: ['COUNTEREVIDENCE_RIVALS_OCCURRENCE'],
  },
  {
    name: 'coach cue drift caused the failure',
    observations: strongEvidence().map((observation) => ({
      ...observation,
      attribution: { target: 'coach_cue' as const, certainty: 'probable' as const },
    })),
    expectedState: 'ATTRIBUTION_UNRESOLVED',
    expectedBlockers: ['ATTRIBUTION_NOT_ATHLETE'],
  },
  {
    name: 'partner failed their assigned role',
    observations: strongEvidence().map((observation) => ({
      ...observation,
      attribution: { target: 'partner_role' as const, certainty: 'stated' as const },
    })),
    expectedState: 'ATTRIBUTION_UNRESOLVED',
    expectedBlockers: ['ATTRIBUTION_NOT_ATHLETE'],
  },
  {
    name: 'attribution split evenly between athlete and room resolves to neither',
    observations: [
      obs(1, { sessionId: 'session-1', taskContextKey: 'task-mitts', observerAccountId: 'coach-a', attribution: { target: 'athlete', certainty: 'probable' } }),
      obs(2, { sessionId: 'session-2', taskContextKey: 'task-mitts', observerAccountId: 'coach-b', attribution: { target: 'athlete', certainty: 'probable' } }),
      obs(3, { sessionId: 'session-3', taskContextKey: 'task-sparring', taskConstraint: 'live', observerAccountId: 'coach-a', attribution: { target: 'task_design', certainty: 'probable' } }),
      obs(4, { sessionId: 'session-4', taskContextKey: 'task-sparring', taskConstraint: 'live', observerAccountId: 'coach-b', attribution: { target: 'task_design', certainty: 'probable' } }),
    ],
    expectedState: 'ATTRIBUTION_UNRESOLVED',
    expectedBlockers: ['ATTRIBUTION_NOT_ATHLETE', 'ATTRIBUTION_SPLIT'],
  },
  {
    name: 'two coaches watching the same task disagree',
    observations: [
      ...strongEvidence(),
      obs(5, { sessionId: 'session-1', taskContextKey: 'task-mitts', observerAccountId: 'coach-c', polarity: 'counterexample' }),
    ],
    expectedState: 'CONTESTED',
    expectedBlockers: ['OBSERVER_DISAGREEMENT'],
  },
  {
    name: 'video disagrees with the coach interpretation',
    observations: [
      ...strongEvidence(),
      obs(5, {
        sessionId: 'session-1',
        taskContextKey: 'task-mitts',
        polarity: 'counterexample',
        observerAccountId: null,
        source: { type: 'computer_vision', quality: 'verified', referenceId: 'clip-1' },
      }),
    ],
    expectedState: 'CONTESTED',
    expectedBlockers: ['VIDEO_CONTRADICTS_OBSERVER'],
  },
  {
    name: 'an older pattern that no longer appears retires',
    observations: strongEvidence().map((observation, index) => ({
      ...observation,
      observedAt: day(index + 1, 1),
    })),
    previouslyEstablished: true,
    expectedState: 'RETIRED',
    expectedBlockers: ['NO_RECENT_EVIDENCE'],
  },
  {
    name: 'counterevidence appearing after formation reopens the question',
    observations: [
      ...strongEvidence(),
      obs(7, { sessionId: 'session-7', taskContextKey: 'task-sparring', polarity: 'counterexample', observerAccountId: 'coach-a' }),
      obs(8, { sessionId: 'session-8', taskContextKey: 'task-sparring', polarity: 'counterexample', observerAccountId: 'coach-b' }),
    ],
    previouslyEstablished: true,
    expectedState: 'CONTESTED',
    expectedBlockers: ['COUNTEREVIDENCE_RIVALS_OCCURRENCE'],
  },
  {
    name: 'AI interpretation alone never becomes athlete truth',
    observations: strongEvidence().map((observation) => ({
      ...observation,
      interpretation: 'ai_proposed' as const,
      observerAccountId: null,
      source: { type: 'computer_vision' as const, quality: 'high' as const, referenceId: 'clip-x' },
    })),
    expectedState: 'CONTINUE_OBSERVING',
    expectedBlockers: ['AI_ONLY_EVIDENCE'],
  },
  {
    name: 'a single observer cannot carry the claim alone under this policy',
    observations: strongEvidence().map((observation) => ({ ...observation, observerAccountId: 'coach-a' })),
    expectedState: 'CONTINUE_OBSERVING',
    expectedBlockers: ['SINGLE_OBSERVER'],
  },
  {
    name: 'controlled drills only does not establish a live behaviour',
    observations: strongEvidence().map((observation) => ({
      ...observation,
      taskConstraint: 'controlled' as const,
    })),
    expectedState: 'CONTINUE_OBSERVING',
    expectedBlockers: ['CONTROLLED_CONTEXT_ONLY'],
  },
];

describe('SHADOW pattern candidate evaluation', () => {
  test.each(cases)('$name', ({ observations, previouslyEstablished, expectedState, expectedBlockers }) => {
    const result = evaluatePatternCandidate({
      organizationId: ORG,
      athleteId: ATHLETE,
      behaviourKey: BEHAVIOUR,
      observations,
      policy,
      asOf: AS_OF,
      previouslyEstablished,
    });

    expect(result.state).toBe(expectedState);
    for (const blocker of expectedBlockers) {
      expect(result.blockers).toContain(blocker);
    }
    if (expectedBlockers.length === 0) {
      expect(result.blockers).toEqual([]);
    }
  });

  test('every evaluation requires human review and stamps its ratified policy', () => {
    for (const testCase of cases) {
      const result = evaluatePatternCandidate({
        organizationId: ORG,
        athleteId: ATHLETE,
        behaviourKey: BEHAVIOUR,
        observations: testCase.observations,
        policy,
        asOf: AS_OF,
        previouslyEstablished: testCase.previouslyEstablished,
      });
      expect(result.humanReviewRequired).toBe(true);
      expect(result.policyVersion).toBe(policy.policyVersion);
      expect(result.policyRatifiedByAccountId).toBe('account-owner-1');
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  test('abstention is the common outcome across the adversarial suite', () => {
    const states = cases.map((testCase) => evaluatePatternCandidate({
      organizationId: ORG,
      athleteId: ATHLETE,
      behaviourKey: BEHAVIOUR,
      observations: testCase.observations,
      policy,
      asOf: AS_OF,
      previouslyEstablished: testCase.previouslyEstablished,
    }).state);

    const promoted = states.filter((state) => state === 'ESTABLISHED_IN_CONTEXT');
    expect(promoted).toHaveLength(1);
    expect(states.length - promoted.length).toBeGreaterThan(10);
  });

  test('only an established candidate carries a promotion proposal, and it stays human-gated', () => {
    const established = evaluatePatternCandidate({
      organizationId: ORG,
      athleteId: ATHLETE,
      behaviourKey: BEHAVIOUR,
      observations: strongEvidence(),
      policy,
      asOf: AS_OF,
    });
    expect(established.promotion).not.toBeNull();
    expect(established.promotion?.requiresHumanAuthorization).toBe(true);
    expect(established.promotion?.proposedState).toBe('pattern');
    expect(established.promotion?.summary).toContain('not a confirmed pattern');

    const abstained = evaluatePatternCandidate({
      organizationId: ORG,
      athleteId: ATHLETE,
      behaviourKey: BEHAVIOUR,
      observations: [obs(1)],
      policy,
      asOf: AS_OF,
    });
    expect(abstained.promotion).toBeNull();
  });

  test('out-of-scope and superseded observations are excluded with a stated reason', () => {
    const result = evaluatePatternCandidate({
      organizationId: ORG,
      athleteId: ATHLETE,
      behaviourKey: BEHAVIOUR,
      observations: [
        ...strongEvidence(),
        obs(10, { organizationId: 'org-2' }),
        obs(11, { athleteId: 'athlete-2' }),
        obs(12, { behaviourKey: 'other_behaviour' }),
        obs(13, { observedAt: 'not-a-date' }),
        obs(14, { source: { type: 'computer_vision', quality: 'failed', referenceId: 'clip-broken' } }),
        // Revises obs-1 after film review; obs-1 drops out of evidence but
        // stays visible as an exclusion.
        obs(15, { supersedesObservationId: 'obs-1', polarity: 'counterexample' }),
      ],
      policy,
      asOf: AS_OF,
    });

    const byId = Object.fromEntries(result.excluded.map((entry) => [entry.observationId, entry.reason]));
    expect(byId['obs-10']).toBe('ORGANIZATION_SCOPE_MISMATCH');
    expect(byId['obs-11']).toBe('ATHLETE_SCOPE_MISMATCH');
    expect(byId['obs-12']).toBe('BEHAVIOUR_KEY_MISMATCH');
    expect(byId['obs-13']).toBe('INVALID_TIMESTAMP');
    expect(byId['obs-14']).toBe('SOURCE_QUALITY_FAIL');
    expect(byId['obs-1']).toBe('SUPERSEDED_OBSERVATION');
    expect(result.provenance.map((entry) => entry.observationId)).not.toContain('obs-1');
  });

  test('is order-independent and yields a stable candidate key', () => {
    const forward = evaluatePatternCandidate({
      organizationId: ORG,
      athleteId: ATHLETE,
      behaviourKey: BEHAVIOUR,
      observations: strongEvidence(),
      policy,
      asOf: AS_OF,
    });
    const reversed = evaluatePatternCandidate({
      organizationId: ORG,
      athleteId: ATHLETE,
      behaviourKey: BEHAVIOUR,
      observations: [...strongEvidence()].reverse(),
      policy,
      asOf: AS_OF,
    });

    expect(reversed.candidateKey).toBe(forward.candidateKey);
    expect(reversed.state).toBe(forward.state);
  });

  test('changing the ratified bar changes the candidate identity', () => {
    const first = evaluatePatternCandidate({
      organizationId: ORG,
      athleteId: ATHLETE,
      behaviourKey: BEHAVIOUR,
      observations: strongEvidence(),
      policy,
      asOf: AS_OF,
    });
    const stricter = evaluatePatternCandidate({
      organizationId: ORG,
      athleteId: ATHLETE,
      behaviourKey: BEHAVIOUR,
      observations: strongEvidence(),
      policy: { ...policy, policyVersion: 'pattern-policy-v1', minimumOccurrences: 6 },
      asOf: AS_OF,
    });

    expect(stricter.candidateKey).not.toBe(first.candidateKey);
    expect(first.state).toBe('ESTABLISHED_IN_CONTEXT');
    expect(stricter.state).toBe('CONTINUE_OBSERVING');
    expect(stricter.blockers).toContain('BELOW_POLICY_OCCURRENCES');
  });

  test('reports the evidence vector rather than a single blended score', () => {
    const result = evaluatePatternCandidate({
      organizationId: ORG,
      athleteId: ATHLETE,
      behaviourKey: BEHAVIOUR,
      observations: strongEvidence(),
      policy,
      asOf: AS_OF,
    });

    expect(result.evidence.occurrenceCount).toBe(4);
    expect(result.evidence.distinctSessions).toBe(3);
    expect(result.evidence.distinctTaskContexts).toBe(2);
    expect(result.evidence.distinctObservers).toBe(2);
    expect(result.contextDiversity.spansConstraintTypes).toBe(true);
    expect(result.attribution.athleteShare).toBe(1);
    expect(result.counterEvidence.count).toBe(0);
    // No scalar confidence/score field exists to be mistaken for a measurement.
    expect(result).not.toHaveProperty('score');
    expect(result).not.toHaveProperty('confidence');
  });
});
