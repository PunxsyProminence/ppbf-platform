/**
 * The last two rungs: does a reviewed intervention outcome justify calling
 * something a lesson about THIS athlete, and does that lesson justify
 * anything about PPBF methodology?
 *
 * The answer to the second question is always no, automatically. See
 * `assertLessonIsNotMethodology` at the bottom of this file.
 *
 * TRANSFER AND RETENTION ARE THE POINT. An intervention that improves the
 * drill it was trained in has demonstrated that the athlete can do the thing
 * when cued, in the place they were cued, on the day they were cued. That is
 * not a lesson; it is a rep. A lesson requires the improvement to show up
 * somewhere nobody trained it (transfer) and later than the session that
 * produced it (retention). Both are cheap to state and expensive to fake,
 * which is exactly what makes them worth requiring.
 */

import { deterministicKey } from '../formulas/identity';
import type {
  BehaviourObservation,
  InterventionOutcomeReview,
  PatternEpistemicState,
  PatternIntervention,
  PatternReasonCode,
  RetentionEvidenceSummary,
  TransferEvidenceSummary,
  ValidatedAthleteLessonEvaluation,
} from './types';

const MILLISECONDS_PER_DAY = 86_400_000;

export interface AthleteLessonPolicy {
  readonly policyVersion: string;
  readonly ratifiedByAccountId: string;
  readonly ratifiedAt: string;

  /** Distinct untrained task contexts that must show improvement. */
  readonly minimumTransferContexts: number;
  /** How long after the intervention retention evidence must fall. */
  readonly retentionWindowDays: number;
  /** Post-window improvement observations required. */
  readonly minimumRetentionObservations: number;

  /**
   * A literal `true`, not a boolean.
   *
   * This is the type system carrying a policy boundary: no ratified policy,
   * however configured, can switch off the human review of an intervention
   * outcome. A caller cannot pass `false` here because `false` is not
   * assignable to `true`, so the guardrail cannot be disabled by
   * configuration -- only by editing this line, which shows up in review.
   */
  readonly requireHumanReviewedOutcome: true;

  /** Outcome states that may support a lesson. `confounded` is rejected. */
  readonly acceptedMatchStates: readonly InterventionOutcomeReview['matchState'][];
}

export function assertAthleteLessonPolicy(policy: AthleteLessonPolicy): void {
  if (!policy || typeof policy !== 'object') {
    throw new TypeError('An athlete lesson policy is required.');
  }
  if (typeof policy.policyVersion !== 'string' || !policy.policyVersion.trim()) {
    throw new TypeError('Athlete lesson policy requires a policyVersion.');
  }
  if (typeof policy.ratifiedByAccountId !== 'string' || !policy.ratifiedByAccountId.trim()) {
    throw new TypeError(
      'Athlete lesson policy requires ratifiedByAccountId: a validation bar must be attributable to a person.',
    );
  }
  if (typeof policy.ratifiedAt !== 'string' || !Number.isFinite(Date.parse(policy.ratifiedAt))) {
    throw new TypeError('Athlete lesson policy requires a valid ratifiedAt timestamp.');
  }
  if (!Number.isInteger(policy.minimumTransferContexts) || policy.minimumTransferContexts < 1) {
    throw new TypeError(
      'minimumTransferContexts must be at least 1: improvement only where it was trained is not transfer.',
    );
  }
  if (!Number.isFinite(policy.retentionWindowDays) || policy.retentionWindowDays <= 0) {
    throw new TypeError(
      'retentionWindowDays must be positive: improvement measured the same day is not retention.',
    );
  }
  if (!Number.isInteger(policy.minimumRetentionObservations) || policy.minimumRetentionObservations < 1) {
    throw new TypeError('minimumRetentionObservations must be at least 1.');
  }
  if (policy.requireHumanReviewedOutcome !== true) {
    throw new TypeError('requireHumanReviewedOutcome cannot be disabled.');
  }
  if (!Array.isArray(policy.acceptedMatchStates) || policy.acceptedMatchStates.length === 0) {
    throw new TypeError('acceptedMatchStates must list at least one accepted outcome state.');
  }
  if (policy.acceptedMatchStates.includes('confounded')) {
    throw new TypeError(
      "acceptedMatchStates cannot include 'confounded': a confounded outcome states that something "
      + 'else changed at the same time, which is the definition of evidence that cannot validate a lesson.',
    );
  }
  if (policy.acceptedMatchStates.includes('miss')) {
    throw new TypeError("acceptedMatchStates cannot include 'miss': a missed outcome validates nothing.");
  }
}

function isImprovement(observation: BehaviourObservation): boolean {
  // Improvement is an actively-recorded counterexample: a coach noting the
  // athlete did the right thing where the pattern predicted they would not.
  // The ABSENCE of occurrences is not improvement -- nobody may have been
  // looking, the athlete may not have been present, and the drill may never
  // have created the opportunity. Silence is not evidence of change.
  return observation.polarity === 'counterexample';
}

export function summarizeTransferEvidence(
  intervention: PatternIntervention,
  postObservations: readonly BehaviourObservation[],
): TransferEvidenceSummary {
  const transferred = postObservations.filter(
    (observation) => isImprovement(observation)
      && observation.taskContextKey !== intervention.trainedTaskContextKey,
  );
  const constraints = new Set(transferred.map((observation) => observation.taskConstraint));
  const taskContextKeys = [...new Set(transferred.map((observation) => observation.taskContextKey))].sort();

  return Object.freeze({
    count: transferred.length,
    distinctTaskContexts: taskContextKeys.length,
    taskContextKeys: Object.freeze(taskContextKeys),
    spansConstraintTypes:
      constraints.has('controlled') && (constraints.has('live') || constraints.has('constrained_live')),
  });
}

export function summarizeRetentionEvidence(
  intervention: PatternIntervention,
  postObservations: readonly BehaviourObservation[],
  policy: AthleteLessonPolicy,
  asOf: string,
): RetentionEvidenceSummary {
  const startedMs = Date.parse(intervention.startedAt);
  const asOfMs = Date.parse(asOf);
  const windowMs = policy.retentionWindowDays * MILLISECONDS_PER_DAY;

  const retained = postObservations.filter((observation) => {
    if (!isImprovement(observation)) return false;
    const observedMs = Date.parse(observation.observedAt);
    return Number.isFinite(observedMs) && observedMs - startedMs >= windowMs;
  });

  const latestMs = retained
    .map((observation) => Date.parse(observation.observedAt))
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
    .at(-1) ?? null;

  return Object.freeze({
    count: retained.length,
    distinctSessions: new Set(retained.map((observation) => observation.sessionId)).size,
    // Whether enough time has passed to have LOOKED for retention at all --
    // distinct from whether retention was found. Without this a lesson
    // evaluated the afternoon of the intervention would report "no retention
    // evidence" as though retention had been tested and failed.
    windowElapsed:
      Number.isFinite(startedMs) && Number.isFinite(asOfMs) && asOfMs - startedMs >= windowMs,
    latestAt: latestMs == null ? null : new Date(latestMs).toISOString(),
  });
}

export interface EvaluateAthleteLessonInput {
  readonly organizationId: string;
  readonly athleteId: string;
  readonly behaviourKey: string;
  /** The standing of the pattern this intervention was aimed at. */
  readonly patternState: PatternEpistemicState;
  readonly intervention: PatternIntervention | null;
  readonly outcome: InterventionOutcomeReview | null;
  /** Every observation of this behaviour recorded at or after the intervention. */
  readonly postObservations: readonly BehaviourObservation[];
  readonly policy: AthleteLessonPolicy;
  /** Required for the same reason as `EvaluatePatternCandidateInput.asOf`. */
  readonly asOf: string;
}

export function evaluateValidatedAthleteLesson(
  input: EvaluateAthleteLessonInput,
): ValidatedAthleteLessonEvaluation {
  assertAthleteLessonPolicy(input.policy);

  const { policy } = input;
  const { asOf } = input;
  if (typeof asOf !== 'string' || !Number.isFinite(Date.parse(asOf))) {
    throw new TypeError('evaluateValidatedAthleteLesson requires a valid asOf timestamp.');
  }
  const blockers: PatternReasonCode[] = [];
  const warnings: PatternReasonCode[] = [];

  const emptyTransfer: TransferEvidenceSummary = Object.freeze({
    count: 0,
    distinctTaskContexts: 0,
    taskContextKeys: Object.freeze([]),
    spansConstraintTypes: false,
  });
  const emptyRetention: RetentionEvidenceSummary = Object.freeze({
    count: 0,
    distinctSessions: 0,
    windowElapsed: false,
    latestAt: null,
  });

  // A lesson cannot be more certain than the pattern it was drawn from. If
  // the pattern never left abstention, an intervention against it was aimed
  // at something nobody established, and its apparent success is a story
  // about a behaviour we could not confirm the athlete had.
  if (input.patternState !== 'ESTABLISHED_IN_CONTEXT') {
    blockers.push('NO_OBSERVATIONS');
  }

  const { intervention } = input;
  if (!intervention) {
    blockers.push('NO_INTERVENTION');
  } else if (!intervention.decisionId) {
    blockers.push('INTERVENTION_NOT_HUMAN_AUTHORIZED');
  }

  const { outcome } = input;
  if (!outcome) {
    blockers.push('OUTCOME_NOT_HUMAN_REVIEWED');
  } else {
    if (!outcome.reviewedByAccountId || !outcome.reviewedAt) {
      blockers.push('OUTCOME_NOT_HUMAN_REVIEWED');
    }
    if (outcome.matchState === 'confounded') {
      blockers.push('OUTCOME_CONFOUNDED');
    } else if (outcome.matchState === 'miss') {
      blockers.push('OUTCOME_MISS');
    } else if (!policy.acceptedMatchStates.includes(outcome.matchState)) {
      blockers.push('OUTCOME_MISS');
    }
    if (outcome.matchState === 'partial') {
      warnings.push('COUNTEREVIDENCE_PRESENT');
    }
  }

  const transfer = intervention
    ? summarizeTransferEvidence(intervention, input.postObservations)
    : emptyTransfer;
  const retention = intervention
    ? summarizeRetentionEvidence(intervention, input.postObservations, policy, asOf)
    : emptyRetention;

  if (intervention) {
    if (transfer.distinctTaskContexts === 0) {
      blockers.push('NO_TRANSFER_EVIDENCE');
    } else if (transfer.distinctTaskContexts < policy.minimumTransferContexts) {
      blockers.push('TRANSFER_CONTEXT_NOT_DISTINCT');
    }

    if (!retention.windowElapsed) {
      // Not yet testable, not yet failed. Distinguishing these is the whole
      // reason windowElapsed exists.
      blockers.push('RETENTION_WINDOW_NOT_ELAPSED');
    } else if (retention.count < policy.minimumRetentionObservations) {
      blockers.push('NO_RETENTION_EVIDENCE');
    }

    // The athlete still doing the thing, after the intervention, in the very
    // context it was trained in.
    const regressed = input.postObservations.some(
      (observation) => observation.polarity === 'occurrence'
        && observation.taskContextKey === intervention.trainedTaskContextKey
        && Date.parse(observation.observedAt) >= Date.parse(intervention.startedAt),
    );
    if (regressed) {
      blockers.push('POST_INTERVENTION_REGRESSION');
    }
  }

  const lessonKey = deterministicKey('athlete_lesson', {
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    behaviourKey: input.behaviourKey,
    interventionId: intervention?.interventionId ?? null,
    outcomeId: outcome?.outcomeId ?? null,
    policyVersion: policy.policyVersion,
  });

  return Object.freeze({
    lessonKey,
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    behaviourKey: input.behaviourKey,

    eligible: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    warnings: Object.freeze([...new Set(warnings)]),

    transfer,
    retention,
    outcomeMatchState: outcome?.matchState ?? null,

    scope: 'athlete_specific' as const,
    // Literal false, always. See assertLessonIsNotMethodology.
    generalizableToMethodology: false as const,
    humanReviewRequired: true as const,

    policyVersion: policy.policyVersion,
    policyRatifiedByAccountId: policy.ratifiedByAccountId,
    evaluatedAt: asOf,
  });
}

/**
 * The last guardrail on the ladder, and the only function here that exists
 * purely to refuse.
 *
 * A validated athlete lesson is one athlete, one behaviour, one reviewed
 * intervention. PPBF methodology is a claim about how to coach ANY athlete.
 * The distance between those is an evidence-weighing judgement across
 * athletes, coaches and time -- the thing `shadow_library`'s human review
 * queue exists to do, with a person holding the pen.
 *
 * This module will never close that gap automatically, so the only honest
 * implementation of "promote a lesson to methodology" is one that throws and
 * names the human path instead. Called by any future caller tempted to wire
 * the two stages together.
 */
export function assertLessonIsNotMethodology(
  lesson: ValidatedAthleteLessonEvaluation,
): never {
  throw new Error(
    `Validated athlete lesson ${lesson.lessonKey} is scoped to athlete ${lesson.athleteId} and cannot be `
    + 'promoted to PPBF methodology by this module. Generalizing a single-athlete lesson requires a human '
    + 'evidence review across athletes; route it through the SHADOW Library review queue instead.',
  );
}
