/**
 * The counting unit is the attempt (episodes.ts), and the lesson rules lane
 * L49 fixed (lessons.ts). Every behavioural case here fails on the code before
 * it (the two marked as controls do not, by design): two
 * readings of one rep counted as two, a pre-lesson improvement counted as
 * transfer, a fault on day one of the drill counted as regression, an
 * unresolved review or an undelivered intervention validating a lesson, and a
 * lesson drawn from an unestablished pattern reported under the wrong code.
 *
 * The policies are TEST policies, not ratified PPBF bars.
 */

import { collapseToEpisodes, episodeKeyOf } from './episodes';
import { evaluateValidatedAthleteLesson, type AthleteLessonPolicy } from './lessons';
import type { PatternInferencePolicy } from './inference/policy';
import type { PatternFormationPolicy } from './policy';
import { evaluatePatternCandidate } from './promotion';
import type { BehaviourObservation, InterventionOutcomeReview, PatternIntervention } from './types';

const ORG = 'org-1';
const ATHLETE = 'athlete-1';
const BEHAVIOUR = 'drops_lead_hand_after_jab';
const AS_OF = '2026-07-01T00:00:00.000Z';

const patternPolicy: PatternFormationPolicy = {
  policyVersion: 'pattern-policy-test-not-ratified',
  ratifiedByAccountId: 'account-owner-1',
  ratifiedAt: '2026-01-01T00:00:00.000Z',
  minimumOccurrences: 2,
  minimumDistinctSessions: 2,
  minimumDistinctTaskContexts: 2,
  minimumDistinctObservers: 1,
  requireHumanObservation: true,
  requireConstraintSpan: false,
  requireFatigueDiversity: false,
  requireVideoCorroboration: false,
  counterEvidenceContestRatio: 0.5,
  minimumAthleteAttributionShare: 0.6,
  evidenceStaleAfterDays: 90,
  minimumObservationSpanDays: 0,
};

function reading(id: string, overrides: Partial<BehaviourObservation> = {}): BehaviourObservation {
  return {
    observationId: id,
    organizationId: ORG,
    athleteId: ATHLETE,
    behaviourKey: BEHAVIOUR,
    sessionId: 'session-1',
    taskContextKey: 'task-mitts',
    taskConstraint: 'controlled',
    fatigueContext: 'fresh',
    observedAt: '2026-06-10T10:00:00.000Z',
    source: { type: 'coach_tag', quality: 'high', referenceId: `ref-${id}` },
    observerAccountId: 'coach-a',
    interpretation: 'human_observed',
    polarity: 'occurrence',
    attribution: { target: 'athlete', certainty: 'probable' },
    ...overrides,
  };
}

const evaluatePattern = (observations: BehaviourObservation[]) => evaluatePatternCandidate({
  organizationId: ORG, athleteId: ATHLETE, behaviourKey: BEHAVIOUR, observations, policy: patternPolicy, asOf: AS_OF,
});

describe('readings of one attempt are one episode', () => {
  test('two coaches scoring the same rep are one occurrence, and one rep is not a pattern', () => {
    const result = evaluatePattern([
      reading('a', { opportunityKey: 'rep-1', observerAccountId: 'coach-a' }),
      reading('b', { opportunityKey: 'rep-1', observerAccountId: 'coach-b' }),
    ]);
    expect(result.evidence.occurrenceCount).toBe(1);
    expect(result.evidence.distinctObservers).toBe(2);
    expect(result.state).toBe('INSUFFICIENT_EVIDENCE');
    expect(result.blockers).toContain('SINGLE_OBSERVATION');
  });

  test('a rep counted once, its second reading still counted as a second pair of eyes', () => {
    const observations = [
      reading('a', { opportunityKey: 'rep-1', observerAccountId: 'coach-a' }),
      reading('b', { opportunityKey: 'rep-1', observerAccountId: 'coach-b' }),
      reading('c', { sessionId: 'session-2', taskContextKey: 'task-sparring', taskConstraint: 'live', observedAt: '2026-06-20T10:00:00.000Z' }),
    ];
    const result = evaluatePattern(observations);
    expect(result.evidence.occurrenceCount).toBe(2);
    expect(result.evidence.distinctSessions).toBe(2);
    expect(result.evidence.distinctObservers).toBe(2);
    // Provenance and the candidate key still name every reading.
    expect(result.provenance.map((row) => row.observationId).sort()).toEqual(['a', 'b', 'c']);
  });

  test('a disputed rep counts as neither, and the dispute is still raised', () => {
    const result = evaluatePattern([
      reading('a', { opportunityKey: 'rep-1', observerAccountId: 'coach-a', polarity: 'occurrence' }),
      reading('b', { opportunityKey: 'rep-1', observerAccountId: 'coach-b', polarity: 'counterexample' }),
      reading('c', { sessionId: 'session-2', taskContextKey: 'task-sparring', observedAt: '2026-06-20T10:00:00.000Z' }),
      reading('d', { sessionId: 'session-3', taskContextKey: 'task-bag', observedAt: '2026-06-25T10:00:00.000Z' }),
    ]);
    expect(result.evidence.occurrenceCount).toBe(2);
    expect(result.evidence.counterexampleCount).toBe(0);
    expect(result.blockers).toContain('OBSERVER_DISAGREEMENT');
    expect(result.state).toBe('CONTESTED');
  });

  test('film of a rep a coach scored corroborates that one occurrence', () => {
    const result = evaluatePattern([
      reading('a', { opportunityKey: 'rep-1' }),
      reading('v', {
        opportunityKey: 'rep-1', observerAccountId: null, interpretation: 'ai_proposed',
        source: { type: 'computer_vision', quality: 'high', referenceId: 'clip-1' },
      }),
    ]);
    expect(result.evidence.occurrenceCount).toBe(1);
    expect(result.evidence.videoCorroboratedCount).toBe(1);
    expect(result.evidence.humanObservedCount).toBe(1);
    expect(result.evidence.aiProposedCount).toBe(0);
    expect(result.evidence.distinctSourceTypes).toBe(2);
  });

  test("one coach's call never hides another's: readings that disagree on whose fault leave the attempt unresolved", () => {
    const observations: BehaviourObservation[] = [];
    ['task-mitts', 'task-sparring', 'task-bag'].forEach((task, index) => {
      const at = `2026-06-${10 + index}T10:00:00.000Z`;
      const session = `session-${index + 1}`;
      // Ids sort coach-b's reading first, then coach-a's: the order must not matter.
      observations.push(reading(`b${index}`, { sessionId: session, taskContextKey: task, observedAt: at, opportunityKey: `rep-${index}`, observerAccountId: 'coach-b', attribution: { target: 'coach_cue', certainty: 'uncertain' } }));
      observations.push(reading(`a${index}`, { sessionId: session, taskContextKey: task, observedAt: at, opportunityKey: `rep-${index}`, observerAccountId: 'coach-a' }));
    });
    const result = evaluatePattern(observations);
    expect(result.state).toBe('ATTRIBUTION_UNRESOLVED');
    expect(result.promotion).toBeNull();
    expect(result.warnings).toEqual(expect.arrayContaining(['COACH_CUE_IMPLICATED', 'ATTRIBUTION_UNCERTAIN']));
  });

  test('an attempt one person read both ways is disputed, never silently dropped', () => {
    const result = evaluatePattern([
      reading('o1', { sessionId: 'session-1', taskContextKey: 'task-mitts', observedAt: '2026-06-10T10:00:00.000Z' }),
      reading('o2', { sessionId: 'session-2', taskContextKey: 'task-sparring', observedAt: '2026-06-12T10:00:00.000Z' }),
      reading('s1', { sessionId: 'session-3', taskContextKey: 'task-bag', observedAt: '2026-06-14T10:00:00.000Z', opportunityKey: 'rep-1' }),
      reading('s2', { sessionId: 'session-3', taskContextKey: 'task-bag', observedAt: '2026-06-14T10:00:00.000Z', opportunityKey: 'rep-1', polarity: 'counterexample' }),
    ]);
    expect(result.blockers).toContain('ATTEMPT_DISPUTED');
    expect(result.state).toBe('CONTESTED');
    expect(result.promotion).toBeNull();
  });

  test("a model's reading never erases a coach's counter-evidence on the same attempt", () => {
    const result = evaluatePattern([
      reading('o1', { sessionId: 'session-1', taskContextKey: 'task-mitts', observedAt: '2026-06-10T10:00:00.000Z' }),
      reading('o2', { sessionId: 'session-2', taskContextKey: 'task-sparring', observedAt: '2026-06-12T10:00:00.000Z' }),
      reading('c', { sessionId: 'session-3', taskContextKey: 'task-bag', opportunityKey: 'rep-1', polarity: 'counterexample' }),
      reading('m', {
        sessionId: 'session-3', taskContextKey: 'task-bag', opportunityKey: 'rep-1', observerAccountId: null,
        interpretation: 'ai_proposed', source: { type: 'imu', quality: 'high', referenceId: 'imu-1' },
      }),
    ]);
    expect(result.blockers).toContain('ATTEMPT_DISPUTED');
    expect(result.state).toBe('CONTESTED');
  });

  test('when every attempt is disputed the candidate is contested; one disputed attempt is still one attempt', () => {
    const twoDisputed = evaluatePattern([
      reading('a1', { opportunityKey: 'rep-1', observerAccountId: 'coach-a' }),
      reading('b1', { opportunityKey: 'rep-1', observerAccountId: 'coach-b', polarity: 'counterexample' }),
      reading('a2', { opportunityKey: 'rep-2', observerAccountId: 'coach-a', sessionId: 'session-2', observedAt: '2026-06-12T10:00:00.000Z' }),
      reading('b2', { opportunityKey: 'rep-2', observerAccountId: 'coach-b', sessionId: 'session-2', observedAt: '2026-06-12T10:00:00.000Z', polarity: 'counterexample' }),
    ]);
    expect(twoDisputed.state).toBe('CONTESTED');
    const oneDisputed = evaluatePattern([
      reading('a1', { opportunityKey: 'rep-1', observerAccountId: 'coach-a' }),
      reading('b1', { opportunityKey: 'rep-1', observerAccountId: 'coach-b', polarity: 'counterexample' }),
    ]);
    expect(oneDisputed.state).toBe('INSUFFICIENT_EVIDENCE');
  });

  // Control: pure grouping rules.
  test('a reading with no key is its own episode; the same key in another session or drill is another attempt', () => {
    const plain = reading('a');
    expect(episodeKeyOf(plain)).not.toBe(episodeKeyOf(reading('b')));
    const collapse = collapseToEpisodes([
      reading('a', { opportunityKey: 'rep-1' }),
      reading('b', { opportunityKey: 'rep-1', sessionId: 'session-2' }),
      reading('c', { opportunityKey: 'rep-1', taskContextKey: 'task-bag' }),
      // Taken exactly as evidence.ts takes it: any non-empty string is a key,
      // untrimmed, so 'rep-1 ' is a different attempt from 'rep-1'.
      reading('d', { opportunityKey: 'rep-1 ' }),
      reading('e', { opportunityKey: null }),
    ]);
    expect(collapse.episodes).toHaveLength(5);
    expect(collapse.disputedEpisodeKeys).toEqual([]);
  });
});

describe('strata count attempts; the observer stratum counts readers', () => {
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

  test('one fatigued rep watched by three coaches is one trial in its stratum', () => {
    const result = evaluatePatternCandidate({
      organizationId: ORG, athleteId: ATHLETE, behaviourKey: BEHAVIOUR, policy: patternPolicy, asOf: AS_OF, inferencePolicy,
      observations: [
        reading('a', { opportunityKey: 'rep-1', fatigueContext: 'fatigued', observerAccountId: 'coach-a' }),
        reading('b', { opportunityKey: 'rep-1', fatigueContext: 'fatigued', observerAccountId: 'coach-b' }),
        reading('c', { opportunityKey: 'rep-1', fatigueContext: 'fatigued', observerAccountId: 'coach-c' }),
      ],
    });
    const strata = result.inference!.attribution.strata;
    const fatigued = strata.find((stratum) => stratum.axis === 'fatigue_context' && stratum.key === 'fatigued');
    expect(fatigued?.trials).toBe(1);
    expect(fatigued?.eligible).toBe(false);
    // Who looked is still every reading.
    expect(strata.filter((stratum) => stratum.axis === 'observer').map((stratum) => stratum.key))
      .toEqual(['coach-a', 'coach-b', 'coach-c']);
  });
});

// ── lessons ─────────────────────────────────────────────────────────────────

const STARTED_AT = '2026-06-01T00:00:00.000Z';

const lessonPolicy: AthleteLessonPolicy = {
  policyVersion: 'lesson-policy-test-not-ratified',
  ratifiedByAccountId: 'account-owner-1',
  ratifiedAt: '2026-01-01T00:00:00.000Z',
  minimumTransferContexts: 1,
  retentionWindowDays: 14,
  minimumRetentionObservations: 2,
  requireHumanReviewedOutcome: true,
  acceptedMatchStates: ['match', 'partial'],
};

const intervention: PatternIntervention = {
  interventionId: 'intervention-1',
  organizationId: ORG,
  athleteId: ATHLETE,
  behaviourKey: BEHAVIOUR,
  decisionId: 'decision-1',
  startedAt: STARTED_AT,
  trainedTaskContextKey: 'task-mitts',
  description: 'Recall cue on the jab return.',
};

const outcome: InterventionOutcomeReview = {
  outcomeId: 'outcome-1',
  interventionId: 'intervention-1',
  matchState: 'match',
  reviewedByAccountId: 'coach-a',
  reviewedAt: '2026-06-25T00:00:00.000Z',
};

/** Improvements that clear the test lesson bar on their own: transfer, and two later retention reps. */
const retained = [
  reading('p1', { sessionId: 'post-1', taskContextKey: 'task-sparring', taskConstraint: 'live', polarity: 'counterexample', observedAt: '2026-06-20T10:00:00.000Z' }),
  reading('p2', { sessionId: 'post-2', taskContextKey: 'task-sparring', taskConstraint: 'live', polarity: 'counterexample', observedAt: '2026-06-22T10:00:00.000Z' }),
];

const evaluateLesson = (overrides: {
  intervention?: PatternIntervention;
  outcome?: InterventionOutcomeReview;
  postObservations?: BehaviourObservation[];
  patternState?: 'ESTABLISHED_IN_CONTEXT' | 'CONTINUE_OBSERVING';
} = {}) => evaluateValidatedAthleteLesson({
  organizationId: ORG,
  athleteId: ATHLETE,
  behaviourKey: BEHAVIOUR,
  patternState: overrides.patternState ?? 'ESTABLISHED_IN_CONTEXT',
  intervention: overrides.intervention ?? intervention,
  outcome: overrides.outcome ?? outcome,
  postObservations: overrides.postObservations ?? retained,
  policy: lessonPolicy,
  asOf: AS_OF,
});

describe('lessons', () => {
  // Control: the fixture itself.
  test('the fixture validates, so each case below isolates one refusal', () => {
    const result = evaluateLesson();
    expect(result.blockers).toEqual([]);
    expect(result.eligible).toBe(true);
  });

  test('a lesson drawn from a pattern nobody established says so by its own name', () => {
    const result = evaluateLesson({ patternState: 'CONTINUE_OBSERVING' });
    expect(result.blockers).toContain('PATTERN_NOT_ESTABLISHED');
    expect(result.blockers).not.toContain('NO_OBSERVATIONS');
  });

  test('an improvement elsewhere BEFORE the lesson is baseline, not transfer', () => {
    const result = evaluateLesson({
      postObservations: [
        reading('early', { sessionId: 'pre-1', taskContextKey: 'task-bag', polarity: 'counterexample', observedAt: '2026-05-20T10:00:00.000Z' }),
        reading('in-drill', { sessionId: 'post-1', taskContextKey: 'task-mitts', polarity: 'counterexample', observedAt: '2026-06-20T10:00:00.000Z' }),
      ],
    });
    expect(result.transfer.count).toBe(0);
    expect(result.blockers).toContain('NO_TRANSFER_EVIDENCE');
  });

  test('a fault while the fix is still drilled is not regression; the same fault after it ended is', () => {
    const duringDrill = reading('day-one', { sessionId: 'drill-1', taskContextKey: 'task-mitts', observedAt: '2026-06-03T10:00:00.000Z' });
    const ended = { ...intervention, endedAt: '2026-06-10T00:00:00.000Z' };
    expect(evaluateLesson({ intervention: ended, postObservations: [...retained, duringDrill] }).blockers)
      .not.toContain('POST_INTERVENTION_REGRESSION');
    const afterEnd = reading('back-again', { sessionId: 'later-1', taskContextKey: 'task-mitts', observedAt: '2026-06-24T10:00:00.000Z' });
    expect(evaluateLesson({ intervention: ended, postObservations: [...retained, afterEnd] }).blockers)
      .toContain('POST_INTERVENTION_REGRESSION');
    // Still running at asOf (no end, or an end after asOf): counted from its start.
    expect(evaluateLesson({ postObservations: [...retained, duringDrill] }).blockers).toContain('POST_INTERVENTION_REGRESSION');
    expect(evaluateLesson({
      intervention: { ...intervention, endedAt: '2026-08-01T00:00:00.000Z' }, postObservations: [...retained, duringDrill],
    }).blockers).toContain('POST_INTERVENTION_REGRESSION');
  });

  test('the coach\'s open answer validates nothing yet', () => {
    for (const review of [
      { ...outcome, hypothesisResult: 'unresolved' as const },
      { ...outcome, hypothesisResult: 'insufficient_evidence' as const },
      { ...outcome, performanceResult: 'unknown' as const },
    ]) {
      const result = evaluateLesson({ outcome: review });
      expect(result.blockers).toContain('OUTCOME_UNRESOLVED');
      expect(result.eligible).toBe(false);
    }
    expect(evaluateLesson({ outcome: { ...outcome, hypothesisResult: 'supported', performanceResult: 'improved' } }).eligible)
      .toBe(true);
  });

  test('a fault one coach saw come back is regression, even when another coach read that rep the other way', () => {
    const result = evaluateLesson({
      postObservations: [
        ...retained,
        reading('ra', { sessionId: 'later-1', taskContextKey: 'task-mitts', observedAt: '2026-06-24T10:00:00.000Z', opportunityKey: 'rep-7', observerAccountId: 'coach-a' }),
        reading('rb', { sessionId: 'later-1', taskContextKey: 'task-mitts', observedAt: '2026-06-24T10:00:00.000Z', opportunityKey: 'rep-7', observerAccountId: 'coach-b', polarity: 'counterexample' }),
      ],
    });
    expect(result.blockers).toContain('POST_INTERVENTION_REGRESSION');
    expect(result.eligible).toBe(false);
  });

  test("the coach's finding against the lesson is read too: confounded, contradicted, no better", () => {
    expect(evaluateLesson({ outcome: { ...outcome, hypothesisResult: 'confounded' } }).blockers).toContain('OUTCOME_CONFOUNDED');
    for (const review of [
      { ...outcome, hypothesisResult: 'contradicted' as const },
      { ...outcome, performanceResult: 'declined' as const },
      { ...outcome, performanceResult: 'unchanged' as const },
    ]) {
      expect(evaluateLesson({ outcome: review }).blockers).toContain('OUTCOME_MISS');
    }
    expect(evaluateLesson({ outcome: { ...outcome, performanceResult: 'mixed' } }).eligible).toBe(true);
  });

  test('an end nobody can place, or one before the start, is no end, and says so', () => {
    const duringDrill = reading('day-one', { sessionId: 'drill-1', taskContextKey: 'task-mitts', observedAt: '2026-06-03T10:00:00.000Z' });
    for (const endedAt of ['not a time', '2026-05-01T00:00:00.000Z']) {
      const result = evaluateLesson({ intervention: { ...intervention, endedAt }, postObservations: [...retained, duringDrill] });
      expect(result.warnings).toContain('INVALID_TIMESTAMP');
      // Counted from the start, as for one still running.
      expect(result.blockers).toContain('POST_INTERVENTION_REGRESSION');
    }
    const before = reading('pre-start', { sessionId: 'pre-1', taskContextKey: 'task-mitts', observedAt: '2026-05-10T10:00:00.000Z' });
    expect(evaluateLesson({
      intervention: { ...intervention, endedAt: '2026-05-01T00:00:00.000Z' }, postObservations: [...retained, before],
    }).blockers).not.toContain('POST_INTERVENTION_REGRESSION');
  });

  test('an intervention never delivered taught nothing; one whose delivery nobody recorded proves nothing yet', () => {
    const result = evaluateLesson({ intervention: { ...intervention, adherence: 'not_delivered' } });
    expect(result.blockers).toContain('INTERVENTION_NOT_DELIVERED');
    const unrecorded = evaluateLesson({ intervention: { ...intervention, adherence: 'unknown' } });
    expect(unrecorded.blockers).toContain('INTERVENTION_DELIVERY_UNRECORDED');
    expect(unrecorded.eligible).toBe(false);
    // No adherence passed at all: the legacy path, unchanged.
    expect(evaluateLesson().eligible).toBe(true);
    expect(evaluateLesson({ intervention: { ...intervention, adherence: 'under_delivered' } }).blockers)
      .not.toContain('INTERVENTION_NOT_DELIVERED');
  });

  test('two coaches reporting one retained rep are one piece of retention', () => {
    const result = evaluateLesson({
      postObservations: [
        reading('r1', { sessionId: 'post-1', taskContextKey: 'task-sparring', polarity: 'counterexample', observedAt: '2026-06-20T10:00:00.000Z', opportunityKey: 'rep-9' }),
        reading('r2', { sessionId: 'post-1', taskContextKey: 'task-sparring', polarity: 'counterexample', observedAt: '2026-06-20T10:00:00.000Z', opportunityKey: 'rep-9', observerAccountId: 'coach-b' }),
      ],
    });
    expect(result.retention.count).toBe(1);
    expect(result.blockers).toContain('NO_RETENTION_EVIDENCE');
  });
});
