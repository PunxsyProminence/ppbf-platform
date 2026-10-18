/**
 * The counting unit is the attempt (episodes.ts), and the lesson rules lane
 * L49 fixed (lessons.ts). Every case here fails on the code before it: two
 * readings of one rep counted as two, a pre-lesson improvement counted as
 * transfer, a fault on day one of the drill counted as regression, an
 * unresolved review or an undelivered intervention validating a lesson, and a
 * lesson drawn from an unestablished pattern reported under the wrong code.
 *
 * The policies are TEST policies, not ratified PPBF bars.
 */

import { collapseToEpisodes, episodeKeyOf } from './episodes';
import { evaluateValidatedAthleteLesson, type AthleteLessonPolicy } from './lessons';
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

  test('a reading with no key is its own episode; the same key in another session or drill is another attempt', () => {
    const plain = reading('a');
    expect(episodeKeyOf(plain)).not.toBe(episodeKeyOf(reading('b')));
    const collapse = collapseToEpisodes([
      reading('a', { opportunityKey: 'rep-1' }),
      reading('b', { opportunityKey: 'rep-1', sessionId: 'session-2' }),
      reading('c', { opportunityKey: 'rep-1', taskContextKey: 'task-bag' }),
      reading('d', { opportunityKey: '  ' }),
      reading('e', { opportunityKey: null }),
    ]);
    expect(collapse.episodes).toHaveLength(5);
    expect(collapse.disputedEpisodeKeys).toEqual([]);
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

  test('an intervention never delivered taught nothing', () => {
    const result = evaluateLesson({ intervention: { ...intervention, adherence: 'not_delivered' } });
    expect(result.blockers).toContain('INTERVENTION_NOT_DELIVERED');
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
