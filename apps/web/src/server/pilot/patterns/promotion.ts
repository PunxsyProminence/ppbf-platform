/**
 * Applies a ratified policy to an evidence vector and returns an epistemic
 * standing plus the reasons behind it.
 *
 * THE CENTRAL PROPERTY: this function can abstain, and abstaining is the
 * expected result for most real inputs. `INSUFFICIENT_EVIDENCE`,
 * `CONTINUE_OBSERVING`, `SINGLE_CONTEXT_ONLY`, `ATTRIBUTION_UNRESOLVED`,
 * `CONTESTED` and `RETIRED` are all successful outputs. A false promotion
 * writes a claim about a child into a coach's screen and an athlete's
 * overlay; an abstention costs one more week of observation.
 *
 * A CODE'S PLACEMENT IS ITS MEANING. Every reason code lands in exactly one
 * of two lists: `blockers` if it prevents promotion under THIS policy,
 * `warnings` if it is true but tolerated. The same code can be either,
 * depending on the ratified bar -- `NO_VIDEO_CORROBORATION` blocks only
 * where an owner has said film is required. That is what makes the output
 * readable as "here is what stopped this" rather than an undifferentiated
 * pile of observations about the data.
 */

import { deterministicKey } from '../formulas/identity';
import {
  admitObservations,
  detectObserverDisagreement,
  detectVideoContradiction,
  recentOccurrenceCount,
  summarizeAttribution,
  summarizeContextDiversity,
  summarizeCounterEvidence,
  summarizeEvidence,
  toProvenance,
} from './evidence';
import { assertPatternFormationPolicy, policyParameters, type PatternFormationPolicy } from './policy';
import type {
  BehaviourObservation,
  PatternCandidateEvaluation,
  PatternEpistemicState,
  PatternPromotionProposal,
  PatternReasonCode,
} from './types';

export interface EvaluatePatternCandidateInput {
  readonly organizationId: string;
  readonly athleteId: string;
  readonly behaviourKey: string;
  readonly observations: readonly BehaviourObservation[];
  readonly policy: PatternFormationPolicy;
  /** Evaluation instant. Supplied by tests for determinism; defaults to now. */
  readonly asOf?: string;
  /**
   * True when a human has previously authorized this behaviour as a pattern.
   * Drives RETIRED: an overlay that was fair last season and has not been
   * seen since is not still true, and letting it persist unchallenged is how
   * an athlete gets coached against a version of themselves they have
   * already outgrown.
   */
  readonly previouslyEstablished?: boolean;
}

class ReasonLedger {
  private readonly blocking = new Set<PatternReasonCode>();
  private readonly warning = new Set<PatternReasonCode>();

  add(code: PatternReasonCode, blocks: boolean): void {
    if (blocks) {
      this.blocking.add(code);
      this.warning.delete(code);
      return;
    }
    if (!this.blocking.has(code)) this.warning.add(code);
  }

  has(code: PatternReasonCode): boolean {
    return this.blocking.has(code);
  }

  get blockers(): readonly PatternReasonCode[] {
    return Object.freeze([...this.blocking]);
  }

  get warnings(): readonly PatternReasonCode[] {
    return Object.freeze([...this.warning]);
  }
}

export function evaluatePatternCandidate(
  input: EvaluatePatternCandidateInput,
): PatternCandidateEvaluation {
  assertPatternFormationPolicy(input.policy);

  const { policy } = input;
  const asOf = input.asOf ?? new Date().toISOString();
  const scope = {
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    behaviourKey: input.behaviourKey,
  };

  const { admitted, excluded } = admitObservations(scope, input.observations);
  const evidence = summarizeEvidence(admitted);
  const contextDiversity = summarizeContextDiversity(admitted);
  const attribution = summarizeAttribution(admitted);
  const counterEvidence = summarizeCounterEvidence(admitted);

  const ledger = new ReasonLedger();

  // ── volume and recurrence ────────────────────────────────────────────────
  if (evidence.occurrenceCount === 0) {
    ledger.add('NO_OBSERVATIONS', true);
  }
  if (evidence.occurrenceCount === 1) {
    ledger.add('SINGLE_OBSERVATION', true);
  }
  if (evidence.occurrenceCount > 0 && evidence.occurrenceCount < policy.minimumOccurrences) {
    ledger.add('BELOW_POLICY_OCCURRENCES', true);
  }
  if (evidence.distinctSessions === 1) {
    ledger.add('SINGLE_SESSION', policy.minimumDistinctSessions > 1);
  }
  if (evidence.occurrenceCount > 0 && evidence.distinctSessions < policy.minimumDistinctSessions) {
    ledger.add('BELOW_POLICY_SESSIONS', true);
  }

  // ── context diversity ────────────────────────────────────────────────────
  if (evidence.distinctTaskContexts === 1) {
    ledger.add('SINGLE_TASK_CONTEXT', true);
  }
  if (evidence.occurrenceCount > 0 && evidence.distinctTaskContexts < policy.minimumDistinctTaskContexts) {
    ledger.add('BELOW_POLICY_TASK_CONTEXTS', true);
  }
  if (evidence.occurrenceCount > 0 && contextDiversity.hasControlledContext && !contextDiversity.hasLiveContext) {
    ledger.add('CONTROLLED_CONTEXT_ONLY', policy.requireConstraintSpan);
  }
  if (evidence.occurrenceCount > 0 && contextDiversity.hasLiveContext && !contextDiversity.hasControlledContext) {
    ledger.add('LIVE_CONTEXT_ONLY', policy.requireConstraintSpan);
  }
  if (contextDiversity.fatigueConfined) {
    ledger.add('FATIGUE_CONTEXT_ONLY', policy.requireFatigueDiversity);
  }
  if (
    evidence.occurrenceCount > 0
    && evidence.fatigueContexts.length === 1
    && evidence.fatigueContexts[0] === 'unknown'
  ) {
    // Never blocking. Demanding a fatigue reading nobody recorded would
    // punish the candidate for a gap in collection rather than a gap in
    // evidence -- but a reviewer still needs to see that the dimension is
    // empty rather than diverse.
    ledger.add('FATIGUE_CONTEXT_UNRECORDED', false);
  }

  // ── observers and sources ────────────────────────────────────────────────
  if (evidence.occurrenceCount > 0 && evidence.distinctObservers < policy.minimumDistinctObservers) {
    ledger.add('SINGLE_OBSERVER', true);
  } else if (evidence.distinctObservers === 1) {
    ledger.add('SINGLE_OBSERVER', false);
  }
  if (evidence.occurrenceCount > 0 && evidence.humanObservedCount === 0) {
    // The hard boundary from the guardrails: an AI interpretation never
    // silently becomes athlete truth. With requireHumanObservation set, a
    // candidate evidenced only by model output cannot leave abstention no
    // matter how many observations it accumulates.
    ledger.add('AI_ONLY_EVIDENCE', policy.requireHumanObservation);
  }
  if (evidence.videoCorroboratedCount === 0) {
    ledger.add('NO_VIDEO_CORROBORATION', policy.requireVideoCorroboration && evidence.occurrenceCount > 0);
  }
  if (admitted.some((observation) => observation.source.quality === 'low')) {
    ledger.add('SOURCE_QUALITY_WARNING', false);
  }

  const observerDisagreement = detectObserverDisagreement(admitted);
  if (observerDisagreement) {
    ledger.add('OBSERVER_DISAGREEMENT', true);
  }
  const videoContradiction = detectVideoContradiction(admitted);
  if (videoContradiction) {
    ledger.add('VIDEO_CONTRADICTS_OBSERVER', true);
  }

  // ── attribution ──────────────────────────────────────────────────────────
  if (attribution.tally.coach_cue > 0) ledger.add('COACH_CUE_IMPLICATED', false);
  if (attribution.tally.task_design > 0) ledger.add('TASK_DESIGN_IMPLICATED', false);
  if (attribution.tally.partner_role > 0) ledger.add('PARTNER_ROLE_IMPLICATED', false);
  if (attribution.uncertainCount > 0) ledger.add('ATTRIBUTION_UNCERTAIN', false);

  if (
    evidence.occurrenceCount > 0
    && attribution.athleteShare != null
    && attribution.athleteShare < policy.minimumAthleteAttributionShare
  ) {
    ledger.add('ATTRIBUTION_NOT_ATHLETE', true);
  }
  if (evidence.occurrenceCount > 0 && attribution.leading == null) {
    ledger.add('ATTRIBUTION_SPLIT', true);
  }

  // ── counter-evidence ─────────────────────────────────────────────────────
  if (counterEvidence.count > 0) {
    ledger.add('COUNTEREVIDENCE_PRESENT', false);
  }
  if (
    counterEvidence.ratioToOccurrences != null
    && counterEvidence.ratioToOccurrences >= policy.counterEvidenceContestRatio
  ) {
    ledger.add('COUNTEREVIDENCE_RIVALS_OCCURRENCE', true);
  }
  if (counterEvidence.count > evidence.occurrenceCount) {
    ledger.add('COUNTEREVIDENCE_DOMINATES', true);
  }

  // ── time ─────────────────────────────────────────────────────────────────
  const recentOccurrences = recentOccurrenceCount(admitted, asOf, policy.evidenceStaleAfterDays);
  if (evidence.occurrenceCount > 0 && recentOccurrences === 0) {
    ledger.add('NO_RECENT_EVIDENCE', true);
    ledger.add('EVIDENCE_STALE', false);
  }
  if (
    policy.minimumObservationSpanDays > 0
    && evidence.observedSpanDays != null
    && evidence.observedSpanDays < policy.minimumObservationSpanDays
  ) {
    ledger.add('OBSERVATION_SPAN_TOO_SHORT', true);
  }

  const state = resolveState({
    hasAdmitted: admitted.length > 0,
    occurrenceCount: evidence.occurrenceCount,
    distinctTaskContexts: evidence.distinctTaskContexts,
    previouslyEstablished: input.previouslyEstablished === true,
    noRecentEvidence: ledger.has('NO_RECENT_EVIDENCE'),
    contested:
      ledger.has('OBSERVER_DISAGREEMENT')
      || ledger.has('VIDEO_CONTRADICTS_OBSERVER')
      || ledger.has('COUNTEREVIDENCE_DOMINATES')
      || ledger.has('COUNTEREVIDENCE_RIVALS_OCCURRENCE'),
    attributionUnresolved:
      ledger.has('ATTRIBUTION_NOT_ATHLETE') || ledger.has('ATTRIBUTION_SPLIT'),
    blockerCount: ledger.blockers.length,
  });

  const candidateKey = deterministicKey('pattern_candidate', {
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    behaviourKey: input.behaviourKey,
    policyVersion: policy.policyVersion,
    parameters: policyParameters(policy),
    observationIds: admitted.map((observation) => observation.observationId),
  });

  return Object.freeze({
    candidateKey,
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    behaviourKey: input.behaviourKey,

    state,
    blockers: ledger.blockers,
    warnings: ledger.warnings,

    evidence,
    contextDiversity,
    attribution,
    counterEvidence,
    provenance: toProvenance(admitted),
    excluded,

    policyVersion: policy.policyVersion,
    policyRatifiedByAccountId: policy.ratifiedByAccountId,
    parameters: policyParameters(policy),

    // Unconditional. There is no branch below this line, and none anywhere in
    // this module, that produces false.
    humanReviewRequired: true,
    promotion: state === 'ESTABLISHED_IN_CONTEXT'
      ? buildProposal(input.behaviourKey, evidence.occurrenceCount, evidence.distinctTaskContexts, ledger.warnings)
      : null,
    evaluatedAt: asOf,
  });
}

/**
 * Precedence, and why it is this order:
 *
 * 1. Did we see anything usable at all?          -> INSUFFICIENT_EVIDENCE
 * 2. Do the sources agree it happened?           -> CONTESTED
 * 3. Whose failure was it?                       -> ATTRIBUTION_UNRESOLVED
 * 4. Has it been seen outside one drill?         -> SINGLE_CONTEXT_ONLY
 * 5. Is a previously-held pattern still current? -> RETIRED
 * 6. Is the ratified bar met?                    -> CONTINUE_OBSERVING
 * 7. Otherwise                                   -> ESTABLISHED_IN_CONTEXT
 *
 * "Did it happen" precedes "whose fault was it", because attributing an event
 * two observers cannot agree occurred is a category error. Context breadth
 * precedes staleness so that a one-drill artefact is named as an artefact
 * rather than as a pattern that faded.
 */
function resolveState(input: {
  hasAdmitted: boolean;
  occurrenceCount: number;
  distinctTaskContexts: number;
  previouslyEstablished: boolean;
  noRecentEvidence: boolean;
  contested: boolean;
  attributionUnresolved: boolean;
  blockerCount: number;
}): PatternEpistemicState {
  if (!input.hasAdmitted || input.occurrenceCount === 0) return 'INSUFFICIENT_EVIDENCE';
  // One rep is one rep, whatever else is true of it. Stated methodology, not
  // a tunable: a policy cannot lower this and neither can a spectacular rep.
  if (input.occurrenceCount === 1) return 'INSUFFICIENT_EVIDENCE';

  if (input.contested) return 'CONTESTED';
  if (input.attributionUnresolved) return 'ATTRIBUTION_UNRESOLVED';
  if (input.distinctTaskContexts === 1) return 'SINGLE_CONTEXT_ONLY';
  if (input.previouslyEstablished && input.noRecentEvidence) return 'RETIRED';
  if (input.blockerCount > 0) return 'CONTINUE_OBSERVING';
  return 'ESTABLISHED_IN_CONTEXT';
}

function buildProposal(
  behaviourKey: string,
  occurrenceCount: number,
  distinctTaskContexts: number,
  qualifiers: readonly PatternReasonCode[],
): PatternPromotionProposal {
  return Object.freeze({
    proposedState: 'pattern' as const,
    requiresHumanAuthorization: true as const,
    qualifiers,
    summary:
      `'${behaviourKey}' met the ratified bar across ${distinctTaskContexts} task contexts `
      + `on ${occurrenceCount} occurrences. This is a proposal for human review, not a confirmed pattern.`,
  });
}
