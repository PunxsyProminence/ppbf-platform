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
import { collapseToEpisodes } from './episodes';
import { admitObservations } from './evidence';
import type {
  BehaviourObservation,
  InterventionOutcomeReview,
  LessonExclusion,
  PatternEpistemicState,
  PatternIntervention,
  PatternReasonCode,
  RetentionEvidenceSummary,
  TransferEvidenceSummary,
  ValidatedAthleteLessonEvaluation,
} from './types';
import { buildSessionRateSeries } from './inference/drift';
import {
  assessSingleCaseDesign,
  type ImprovementDirection,
  type SingleCaseAssessment,
  type SingleCaseDesignPolicy,
} from './inference/singleCase';


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

function observationExclusion(
  entry: { readonly observationId: string; readonly reason: PatternReasonCode },
): LessonExclusion {
  return Object.freeze({ kind: 'observation' as const, id: entry.observationId, reason: entry.reason });
}

/**
 * The intervention as it stood at asOf, or null.
 *
 * One that belongs to another organization, athlete or behaviour, or whose
 * start nobody can place, is absent and reported. One that had not started
 * by asOf is absent silently: it did not exist yet, so a later start cannot
 * change an earlier lesson.
 */
function admitIntervention(
  intervention: PatternIntervention | null,
  scope: { readonly organizationId: string; readonly athleteId: string; readonly behaviourKey: string },
  asOfMs: number,
  excluded: LessonExclusion[],
): PatternIntervention | null {
  if (!intervention) return null;
  const startedMs = Date.parse(intervention.startedAt);
  // Checked first, as for observations: a record that did not exist yet is
  // not reported, whatever else is wrong with it.
  if (startedMs > asOfMs) return null;
  let reason: PatternReasonCode | null = null;
  if (intervention.organizationId !== scope.organizationId) reason = 'ORGANIZATION_SCOPE_MISMATCH';
  else if (intervention.athleteId !== scope.athleteId) reason = 'ATHLETE_SCOPE_MISMATCH';
  else if (intervention.behaviourKey !== scope.behaviourKey) reason = 'BEHAVIOUR_KEY_MISMATCH';
  else if (!Number.isFinite(startedMs)) reason = 'INVALID_TIMESTAMP';
  if (reason !== null) {
    excluded.push(Object.freeze({ kind: 'intervention' as const, id: intervention.interventionId, reason }));
    return null;
  }
  return intervention;
}

/**
 * The outcome review as it stood at asOf, or null. Same rule as the
 * intervention: not yet reviewed at asOf is absent silently; a review time
 * nobody can place, or an outcome of some other intervention than the one
 * being evaluated, is absent and reported. An outcome of the supplied
 * intervention that had not started by asOf goes with it, silently. An
 * outcome with no review time at all is kept -- it is an unreviewed outcome,
 * and says so below.
 */
function admitOutcome(
  outcome: InterventionOutcomeReview | null,
  supplied: PatternIntervention | null,
  intervention: PatternIntervention | null,
  asOfMs: number,
  excluded: LessonExclusion[],
): InterventionOutcomeReview | null {
  if (!outcome) return null;
  // First, as for the intervention itself: an outcome of an intervention that
  // had not started by asOf did not exist yet, so nothing else about it --
  // not even an unreadable review time -- is reported.
  if (
    supplied
    && Date.parse(supplied.startedAt) > asOfMs
    && outcome.interventionId === supplied.interventionId
  ) {
    return null;
  }
  if (outcome.reviewedAt) {
    const reviewedMs = Date.parse(outcome.reviewedAt);
    if (!Number.isFinite(reviewedMs)) {
      excluded.push(Object.freeze({ kind: 'outcome' as const, id: outcome.outcomeId, reason: 'INVALID_TIMESTAMP' as const }));
      return null;
    }
    if (reviewedMs > asOfMs) return null;
  }
  if (!intervention || outcome.interventionId !== intervention.interventionId) {
    excluded.push(Object.freeze({
      kind: 'outcome' as const,
      id: outcome.outcomeId,
      reason: 'OUTCOME_INTERVENTION_MISMATCH' as const,
    }));
    return null;
  }
  return outcome;
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
  // Only after the intervention began: an improvement elsewhere BEFORE the
  // lesson is the baseline, not its transfer.
  const startedMs = Date.parse(intervention.startedAt);
  const transferred = postObservations.filter(
    (observation) => isImprovement(observation)
      && observation.taskContextKey !== intervention.trainedTaskContextKey
      && Date.parse(observation.observedAt) >= startedMs,
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

/**
 * Retention is measured from the lesson's END: the approved bar's delayed
 * probe comes "at least 24 hours after the lesson" (report row C1;
 * OD-2026-10-17-027), and a rep while the drill still runs is the drill, not
 * the lesson holding. From its start only when it has no end -- none recorded,
 * or one nobody can place or that comes before the start (the evaluator warns
 * INVALID_TIMESTAMP for those). An end after asOf means it is still running,
 * so retention is not yet testable.
 */
function retentionFromMs(intervention: PatternIntervention): number {
  const startedMs = Date.parse(intervention.startedAt);
  const endedMs = intervention.endedAt ? Date.parse(intervention.endedAt) : Number.NaN;
  return Number.isFinite(endedMs) && endedMs >= startedMs ? endedMs : startedMs;
}

export function summarizeRetentionEvidence(
  intervention: PatternIntervention,
  postObservations: readonly BehaviourObservation[],
  policy: AthleteLessonPolicy,
  asOf: string,
): RetentionEvidenceSummary {
  const fromMs = retentionFromMs(intervention);
  const asOfMs = Date.parse(asOf);
  const windowMs = policy.retentionWindowDays * MILLISECONDS_PER_DAY;

  const retained = postObservations.filter((observation) => {
    if (!isImprovement(observation)) return false;
    const observedMs = Date.parse(observation.observedAt);
    return Number.isFinite(observedMs) && observedMs - fromMs >= windowMs && observedMs <= asOfMs;
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
      Number.isFinite(fromMs) && Number.isFinite(asOfMs) && asOfMs - fromMs >= windowMs,
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

  /**
   * Optional single-case design comparison. Supply all three or none.
   *
   * Counting post-intervention occurrences cannot distinguish an intervention
   * that worked from a kid who was already improving before anyone intervened.
   * These three inputs let the baseline speak for itself.
   */
  readonly preObservations?: readonly BehaviourObservation[];
  readonly singleCaseDesignPolicy?: SingleCaseDesignPolicy;
  /**
   * Which way is better. Required alongside the policy rather than assumed:
   * every behaviour on this ladder happens to be a fault, but encoding that
   * assumption silently is how it survives the first exception.
   */
  readonly improvementDirection?: ImprovementDirection;
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
    blockers.push('PATTERN_NOT_ESTABLISHED');
  }

  // Same admission as the candidate ladder: another athlete's records, a
  // dropped duplicate, a failed capture, or anything observed after asOf is
  // not evidence about this athlete's lesson at asOf.
  const scope = {
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    behaviourKey: input.behaviourKey,
  };
  const postAdmission = admitObservations(scope, input.postObservations, asOf);
  // Counted per attempt (episodes.ts): two coaches reporting the same rep
  // after the lesson are one piece of transfer or retention, not two.
  const postObservations = collapseToEpisodes(postAdmission.admitted).episodes;
  const excluded: LessonExclusion[] = postAdmission.excluded.map(observationExclusion);

  const asOfMs = Date.parse(asOf);
  const intervention = admitIntervention(input.intervention, scope, asOfMs, excluded);
  const outcome = admitOutcome(input.outcome, input.intervention, intervention, asOfMs, excluded);

  if (!intervention) {
    blockers.push('NO_INTERVENTION');
  } else if (!intervention.decisionId) {
    blockers.push('INTERVENTION_NOT_HUMAN_AUTHORIZED');
  }
  if (intervention?.adherence === 'not_delivered') {
    blockers.push('INTERVENTION_NOT_DELIVERED');
  }
  // The ledger's own "unknown" -- delivery never recorded -- is not proof the
  // lesson was given (approved bar W6: delivery recorded). A caller that
  // passes no adherence at all is the legacy path, and is left as it was.
  if (intervention?.adherence === 'unknown') {
    blockers.push('INTERVENTION_DELIVERY_UNRECORDED');
  }

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
    // The coach's own answers (the intervention ledger's), read, not judged.
    // A belief they left open, or a performance they could not call, supports
    // no lesson yet; a belief they found confounded or contradicted, or a
    // performance that stayed put or fell, supports none at all -- the same
    // lines the ledger's own checks draw.
    if (
      outcome.hypothesisResult === 'unresolved'
      || outcome.hypothesisResult === 'insufficient_evidence'
      || outcome.performanceResult === 'unknown'
    ) {
      blockers.push('OUTCOME_UNRESOLVED');
    }
    if (outcome.hypothesisResult === 'confounded') blockers.push('OUTCOME_CONFOUNDED');
    if (
      outcome.hypothesisResult === 'contradicted'
      || outcome.performanceResult === 'declined'
      || outcome.performanceResult === 'unchanged'
    ) {
      blockers.push('OUTCOME_MISS');
    }
  }

  const transfer = intervention
    ? summarizeTransferEvidence(intervention, postObservations)
    : emptyTransfer;
  const retention = intervention
    ? summarizeRetentionEvidence(intervention, postObservations, policy, asOf)
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
    // context it was trained in. AFTER means after it ended, when it has
    // ended by asOf: a fault on day one, while the fix is still being
    // drilled, is why the drill exists, not a sign it failed. While it runs,
    // from its start.
    const startedAtMs = Date.parse(intervention.startedAt);
    const endedMs = intervention.endedAt ? Date.parse(intervention.endedAt) : Number.NaN;
    // An end nobody can place, or one before the start, is no end: the window
    // stays at the start, and the reviewer is told.
    if (intervention.endedAt && (!Number.isFinite(endedMs) || endedMs < startedAtMs)) {
      warnings.push('INVALID_TIMESTAMP');
    }
    const regressionFromMs = Number.isFinite(endedMs) && endedMs >= startedAtMs && endedMs <= asOfMs
      ? endedMs
      : startedAtMs;
    // Read from every reading, not the counted episodes: a rep one coach saw
    // the fault come back in is regression to be looked at, even when another
    // coach read the same rep the other way (episodes.ts drops that rep from
    // the counts, and nothing in a lesson would otherwise say so).
    const regressed = postAdmission.admitted.some(
      (observation) => observation.polarity === 'occurrence'
        && observation.taskContextKey === intervention.trainedTaskContextKey
        && Date.parse(observation.observedAt) >= regressionFromMs,
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

  // ── single-case design (optional; additive blockers only) ────────────────
  //
  // Same asymmetry as the pattern ladder: this can only ever add a blocker.
  // A lesson the counting rules refused stays refused, and no p-value clears
  // a human-review or authorization gate.
  let singleCase: SingleCaseAssessment | null = null;
  if (input.singleCaseDesignPolicy) {
    if (!input.preObservations || !input.improvementDirection) {
      throw new TypeError(
        'SCD_POLICY_MISSING: a single-case design policy requires preObservations and improvementDirection. '
        + 'A post-intervention series with no baseline is not a comparison.',
      );
    }
    const preAdmission = admitObservations(scope, input.preObservations, asOf);
    excluded.push(...preAdmission.excluded.map(observationExclusion));
    const baseline = buildSessionRateSeries(collapseToEpisodes(preAdmission.admitted).episodes).map((point) => point.rate);
    const treatment = buildSessionRateSeries(postObservations).map((point) => point.rate);
    singleCase = assessSingleCaseDesign(
      { baseline, treatment, direction: input.improvementDirection },
      input.singleCaseDesignPolicy,
    );

    if (singleCase.verdict === 'insufficient_evidence') blockers.push('SCD_PHASE_TOO_SHORT');
    if (singleCase.verdict === 'baseline_unstable') blockers.push('SCD_BASELINE_UNSTABLE');
    if (singleCase.verdict === 'no_effect_detected') blockers.push('SCD_NO_EFFECT_DETECTED');
  }

  return Object.freeze({
    lessonKey,
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    behaviourKey: input.behaviourKey,

    eligible: blockers.length === 0,
    blockers: Object.freeze([...new Set(blockers)]),
    warnings: Object.freeze([...new Set(warnings)]),
    excluded: Object.freeze(excluded),

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
    singleCase,
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
