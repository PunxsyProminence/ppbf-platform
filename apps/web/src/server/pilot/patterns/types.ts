/**
 * SHADOW behavioural pattern formation -- contract types.
 *
 * This module models the coaching-evidence ladder:
 *
 *   Observation -> PatternCandidate -> Pattern -> Intervention
 *     -> human-reviewed Outcome -> ValidatedAthleteLesson
 *
 * It is the BEHAVIOURAL sibling of `../formulas`, which owns the NUMERIC
 * ladder (NumericObservation -> FormulaResult). The two deliberately share
 * `ObservationSource`/`SourceQuality` so "who saw this, and how well" means
 * exactly one thing across SHADOW, and deliberately do NOT share an
 * observation type: a formula observation carries a number and a unit, a
 * behavioural observation carries a named behaviour and the context it
 * happened in. Collapsing them would force one to lie about the other.
 *
 * THREE BOUNDARIES THIS MODULE EXISTS TO HOLD:
 *
 * 1. Nothing here decides anything. Every evaluation returns a proposal
 *    plus the evidence behind it; `humanReviewRequired` is `true` on every
 *    result, unconditionally, and there is no code path that sets it false.
 * 2. No occurrence threshold is defined in this file or any sibling. The
 *    bar lives in a caller-supplied `PatternFormationPolicy` carrying a
 *    `policyVersion` and the account that ratified it, so a threshold is
 *    always attributable to a person rather than to the algorithm. No
 *    evidence currently establishes "N observations = a pattern"; inventing
 *    one here would manufacture exactly the false precision this ladder is
 *    meant to prevent.
 * 3. Abstention is a success. `INSUFFICIENT_EVIDENCE`, `CONTINUE_OBSERVING`,
 *    `ATTRIBUTION_UNRESOLVED`, `SINGLE_CONTEXT_ONLY` and `CONTESTED` are
 *    normal, correct outputs -- not errors and not failures to compute.
 *
 * NOT IN SCOPE, deliberately: `pilot.shadow_decisions` is the human-authorized
 * ORGANIZATIONAL decision lifecycle. PPBF's in-ring tactical vocabulary
 * (score / reposition / reset / deny) is a different concept that shares no
 * type with it and none with this module.
 */

import type { ObservationSource } from '../formulas/types';

// Re-exported so callers of this module never reach past it into the formula
// engine for the source vocabulary -- one import, one meaning.
export type {
  ObservationSource,
  ObservationSourceType,
  SourceQuality,
} from '../formulas/types';

/**
 * How constrained the task was when the behaviour was observed.
 *
 * The distinction matters because a behaviour that only ever appears in a
 * fully controlled drill has not been shown to survive contact with a live
 * opponent, and a behaviour that only appears live has not been isolated.
 * Neither is "better"; a pattern claimed across both is simply better
 * evidenced than one claimed from either alone.
 */
export type TaskConstraint = 'controlled' | 'constrained_live' | 'live';

/**
 * Fatigue/load state at observation time.
 *
 * `unknown` is a first-class value, not a gap to be filled: an observation
 * recorded without a fatigue reading must not be silently counted as
 * `fresh`, because "the athlete does this when tired" and "the athlete does
 * this" are different claims and only one of them is supported.
 */
export type FatigueContext = 'fresh' | 'moderate' | 'fatigued' | 'unknown';

/**
 * Whether the failure being recorded is the athlete's at all.
 *
 * PPBF methodology separates athlete failure from coach/room/task failure,
 * and the earliest useful failure in a chain is frequently NOT the athlete.
 * If a coach cued the wrong thing, the drill was mis-specified, or a partner
 * did not hold their assigned role, the athlete's behaviour is a downstream
 * symptom and an athlete overlay built on it would be a false attribution.
 */
export type AttributionTarget =
  | 'athlete'
  | 'coach_cue'
  | 'task_design'
  | 'partner_role'
  | 'environment'
  | 'equipment'
  | 'unresolved';

/**
 * Ordinal, not numeric, and deliberately so.
 *
 * A coach can honestly say "I am fairly sure the cue caused this" and cannot
 * honestly say "0.72". Storing an invented float here would let downstream
 * arithmetic average, weight, and threshold a number nobody measured -- the
 * precise failure mode this ladder exists to prevent.
 */
export type AttributionCertainty = 'stated' | 'probable' | 'uncertain';

export interface ObservationAttribution {
  readonly target: AttributionTarget;
  readonly certainty: AttributionCertainty;
  /** Free-text rationale from the observer. Never parsed, only carried. */
  readonly note?: string;
}

/**
 * Who authored the interpretation, as opposed to who/what captured the raw
 * material. `ai_proposed` never becomes athlete truth on its own: a candidate
 * evidenced only by AI-proposed observations cannot leave abstention, however
 * many of them there are (see PATTERN_REASON_CODES.AI_ONLY_EVIDENCE).
 */
export type InterpretationOrigin = 'human_observed' | 'ai_proposed';

/**
 * Whether this observation supports the behaviour claim or cuts against it.
 *
 * Counterexamples are recorded as observations of the same `behaviourKey`,
 * not as absences. An absence is unobserved; a counterexample is a coach
 * actively noting the athlete did the right thing in a context where the
 * claimed pattern predicts they would not.
 */
export type ObservationPolarity = 'occurrence' | 'counterexample';

/**
 * One recorded instance of a named behaviour, in one context, by one source.
 *
 * BEHAVIOUR, NOT PERSONALITY. `behaviourKey` names something an athlete did
 * that a second observer could have seen and disagreed about
 * ('drops_lead_hand_after_jab'). It must not name a disposition
 * ('lacks_discipline'): a disposition cannot be observed, cannot be
 * counter-exampled, and cannot be intervened on, so it cannot travel this
 * ladder at all.
 */
export interface BehaviourObservation {
  readonly observationId: string;
  readonly organizationId: string;
  readonly athleteId: string;
  readonly behaviourKey: string;

  /**
   * The session/run this was seen in. Distinct sessions are the unit of
   * "seen again on another day" -- three observations inside one session are
   * one session's worth of evidence, however many times the behaviour fired.
   */
  readonly sessionId: string;

  /**
   * The drill/task the athlete was doing. Distinct task contexts are the
   * unit of "this is not an artefact of one drill". Aligns with the session
   * script block a run executes.
   */
  readonly taskContextKey: string;

  readonly taskConstraint: TaskConstraint;
  readonly fatigueContext: FatigueContext;
  readonly observedAt: string;

  /** Reused verbatim from the formula engine. `computer_vision` is the video path. */
  readonly source: ObservationSource;

  /**
   * The human whose eyes/judgement this is, when there is one. Null for a
   * machine-captured observation. Distinct observers are the unit of
   * "more than one person saw it", which is what makes a claim survive one
   * coach's bad day.
   */
  readonly observerAccountId: string | null;

  readonly interpretation: InterpretationOrigin;
  readonly polarity: ObservationPolarity;
  readonly attribution: ObservationAttribution;

  /**
   * Set when a later observation replaces this one -- a coach revising their
   * own call after watching film, typically. Superseded observations are
   * excluded from evidence rather than deleted, so the revision stays
   * auditable and the original never silently vanishes from provenance.
   */
  readonly supersedesObservationId?: string | null;

  /** Free-text; carried into provenance, never parsed for meaning. */
  readonly note?: string;
}

/**
 * Reason codes. Same idiom as the formula engine's `ValidationReasonCode`:
 * a machine-readable statement of WHY a result is what it is, so a UI can
 * explain an abstention instead of rendering an unexplained blank.
 *
 * `blockers` prevent a candidate from being proposed as a pattern.
 * `warnings` qualify a proposal without stopping it.
 */
export type PatternReasonCode =
  // --- volume / recurrence -------------------------------------------------
  | 'NO_OBSERVATIONS'
  | 'SINGLE_OBSERVATION'
  | 'SINGLE_SESSION'
  | 'BELOW_POLICY_OCCURRENCES'
  | 'BELOW_POLICY_SESSIONS'
  // --- context diversity ---------------------------------------------------
  | 'SINGLE_TASK_CONTEXT'
  | 'BELOW_POLICY_TASK_CONTEXTS'
  | 'CONTROLLED_CONTEXT_ONLY'
  | 'LIVE_CONTEXT_ONLY'
  | 'FATIGUE_CONTEXT_ONLY'
  | 'FATIGUE_CONTEXT_UNRECORDED'
  // --- source / observer ---------------------------------------------------
  | 'SINGLE_OBSERVER'
  | 'AI_ONLY_EVIDENCE'
  | 'SOURCE_QUALITY_FAIL'
  | 'SOURCE_QUALITY_WARNING'
  | 'NO_VIDEO_CORROBORATION'
  | 'VIDEO_CONTRADICTS_OBSERVER'
  | 'OBSERVER_DISAGREEMENT'
  // --- attribution ---------------------------------------------------------
  | 'ATTRIBUTION_NOT_ATHLETE'
  | 'ATTRIBUTION_SPLIT'
  | 'ATTRIBUTION_UNCERTAIN'
  | 'COACH_CUE_IMPLICATED'
  | 'TASK_DESIGN_IMPLICATED'
  | 'PARTNER_ROLE_IMPLICATED'
  // --- counter-evidence ----------------------------------------------------
  | 'COUNTEREVIDENCE_PRESENT'
  | 'COUNTEREVIDENCE_RIVALS_OCCURRENCE'
  | 'COUNTEREVIDENCE_DOMINATES'
  // --- time ----------------------------------------------------------------
  | 'EVIDENCE_STALE'
  | 'NO_RECENT_EVIDENCE'
  | 'OBSERVATION_SPAN_TOO_SHORT'
  // --- integrity -----------------------------------------------------------
  | 'ORGANIZATION_SCOPE_MISMATCH'
  | 'ATHLETE_SCOPE_MISMATCH'
  | 'BEHAVIOUR_KEY_MISMATCH'
  | 'INVALID_TIMESTAMP'
  | 'DUPLICATE_OBSERVATION_ID'
  | 'SUPERSEDED_OBSERVATION'
  // --- Phase A inference (see ./inference) --------------------------------
  // These sit alongside the rule-based codes above and feed the SAME
  // PatternEpistemicState. There is no parallel verdict vocabulary.
  | 'INFERENCE_POLICY_MISSING'
  | 'POSTERIOR_TOO_WIDE'
  | 'RECURRENCE_RATE_BELOW_POLICY'
  | 'SEQUENTIAL_TEST_REJECTED'
  | 'SEQUENTIAL_TEST_CONTINUE'
  | 'STRATA_DISAGREEMENT'
  | 'LOAD_STRATUM_IMPLICATED'
  | 'PATTERN_FADING'
  // --- single-case design (see ./inference/singleCase) ---------------------
  | 'SCD_POLICY_MISSING'
  | 'SCD_PHASE_TOO_SHORT'
  | 'SCD_BASELINE_UNSTABLE'
  | 'SCD_NO_EFFECT_DETECTED'
  // --- intervention / lesson ----------------------------------------------
  | 'NO_INTERVENTION'
  | 'INTERVENTION_NOT_HUMAN_AUTHORIZED'
  | 'OUTCOME_NOT_HUMAN_REVIEWED'
  | 'OUTCOME_CONFOUNDED'
  | 'OUTCOME_MISS'
  | 'NO_TRANSFER_EVIDENCE'
  | 'NO_RETENTION_EVIDENCE'
  | 'TRANSFER_CONTEXT_NOT_DISTINCT'
  | 'RETENTION_WINDOW_NOT_ELAPSED'
  | 'POST_INTERVENTION_REGRESSION';

/**
 * The candidate's epistemic standing.
 *
 * Exactly one of these is not an abstention: `ESTABLISHED_IN_CONTEXT`, and
 * even that produces a human-gated PROPOSAL rather than an athlete overlay.
 */
export type PatternEpistemicState =
  /** Nothing usable -- no observations, or none that survived integrity checks. */
  | 'INSUFFICIENT_EVIDENCE'
  /** Real signal, policy bar not yet met. The expected state for young evidence. */
  | 'CONTINUE_OBSERVING'
  /** Recurs, but has never been seen outside one drill/task. An artefact risk. */
  | 'SINGLE_CONTEXT_ONLY'
  /** May not be the athlete's failure at all. Fix the room before the athlete. */
  | 'ATTRIBUTION_UNRESOLVED'
  /** Sources or observers disagree, or counterexamples rival occurrences. */
  | 'CONTESTED'
  /** Meets the ratified bar across contexts. Proposable, still human-gated. */
  | 'ESTABLISHED_IN_CONTEXT'
  /** Was established once; recent evidence no longer supports it. */
  | 'RETIRED';

export function isAbstention(state: PatternEpistemicState): boolean {
  return state !== 'ESTABLISHED_IN_CONTEXT';
}

/** Per-observation provenance snapshot, mirroring `ProvenanceSnapshot`. */
export interface PatternObservationProvenance {
  readonly observationId: string;
  readonly sessionId: string;
  readonly taskContextKey: string;
  readonly taskConstraint: TaskConstraint;
  readonly fatigueContext: FatigueContext;
  readonly observedAt: string;
  readonly sourceType: ObservationSource['type'];
  readonly sourceQuality: ObservationSource['quality'];
  readonly observerAccountId: string | null;
  readonly interpretation: InterpretationOrigin;
  readonly polarity: ObservationPolarity;
  readonly attributionTarget: AttributionTarget;
  readonly attributionCertainty: AttributionCertainty;
}

/**
 * The evidence vector.
 *
 * Deliberately a vector of counts and sets rather than one blended score.
 * A single number would have to weight "seen in four sessions" against
 * "two coaches disagree" against "video says otherwise", and no evidence
 * exists for any such weighting. Callers and reviewers read the dimensions.
 */
export interface PatternEvidenceSummary {
  readonly occurrenceCount: number;
  readonly counterexampleCount: number;
  readonly totalObservations: number;

  readonly distinctSessions: number;
  readonly distinctTaskContexts: number;
  readonly distinctObservers: number;
  readonly distinctSourceTypes: number;

  readonly taskConstraints: readonly TaskConstraint[];
  readonly fatigueContexts: readonly FatigueContext[];

  readonly humanObservedCount: number;
  readonly aiProposedCount: number;
  readonly videoCorroboratedCount: number;

  readonly firstObservedAt: string | null;
  readonly lastObservedAt: string | null;
  readonly observedSpanDays: number | null;
}

export interface ContextDiversitySummary {
  readonly distinctTaskContexts: number;
  readonly distinctSessions: number;
  readonly hasControlledContext: boolean;
  readonly hasLiveContext: boolean;
  /** True when the behaviour has been seen in both a controlled and a live task. */
  readonly spansConstraintTypes: boolean;
  readonly distinctFatigueContexts: number;
  /** True when every occurrence sits in exactly one fatigue state. */
  readonly fatigueConfined: boolean;
  readonly confinedFatigueContext: FatigueContext | null;
}

export interface AttributionSummary {
  /** Counts per target, over occurrences only -- counterexamples attribute nothing. */
  readonly tally: Readonly<Record<AttributionTarget, number>>;
  /** The most-attributed target, or null when there is a tie or no evidence. */
  readonly leading: AttributionTarget | null;
  /** Share of occurrences attributed to the athlete, 0-1, or null when none. */
  readonly athleteShare: number | null;
  /** True when any occurrence points at coach/task/partner/environment/equipment. */
  readonly nonAthleteImplicated: boolean;
  readonly uncertainCount: number;
}

export interface CounterEvidenceSummary {
  readonly count: number;
  readonly distinctSessions: number;
  readonly distinctTaskContexts: number;
  readonly mostRecentAt: string | null;
  /** Counterexamples divided by occurrences; null when there are no occurrences. */
  readonly ratioToOccurrences: number | null;
  /** True when the most recent evidence for this behaviour is a counterexample. */
  readonly isMostRecentEvidence: boolean;
}

/**
 * What a caller may do with an `ESTABLISHED_IN_CONTEXT` candidate.
 *
 * A proposal, never an overlay. `requiresHumanAuthorization` is `true` on
 * every instance; there is no constructor that produces a false.
 */
export interface PatternPromotionProposal {
  readonly proposedState: 'pattern';
  readonly requiresHumanAuthorization: true;
  /** Codes that qualify the proposal without blocking it. */
  readonly qualifiers: readonly PatternReasonCode[];
  readonly summary: string;
}

export interface PatternCandidateEvaluation {
  readonly candidateKey: string;
  readonly organizationId: string;
  readonly athleteId: string;
  readonly behaviourKey: string;

  readonly state: PatternEpistemicState;
  readonly blockers: readonly PatternReasonCode[];
  readonly warnings: readonly PatternReasonCode[];

  readonly evidence: PatternEvidenceSummary;
  readonly contextDiversity: ContextDiversitySummary;
  readonly attribution: AttributionSummary;
  readonly counterEvidence: CounterEvidenceSummary;
  readonly provenance: readonly PatternObservationProvenance[];

  /** Observations excluded before evaluation, with the code that excluded them. */
  readonly excluded: readonly { readonly observationId: string; readonly reason: PatternReasonCode }[];

  readonly policyVersion: string;
  readonly policyRatifiedByAccountId: string;
  readonly parameters: Readonly<Record<string, unknown>>;

  /** Always true. No code path in this module sets it false. */
  readonly humanReviewRequired: true;
  readonly promotion: PatternPromotionProposal | null;
  readonly evaluatedAt: string;

  /**
   * Phase A inference output, present only when an inference policy was
   * supplied. Null means the rules alone decided -- not that inference ran
   * and found nothing.
   *
   * Typed loosely here to keep `types.ts` free of a dependency on
   * `./inference`; the concrete shape is `PatternInferenceReport`.
   */
  readonly inference: unknown | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Intervention -> human-reviewed outcome -> validated athlete lesson
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A coaching action taken against an established pattern.
 *
 * `decisionId` points at `pilot.shadow_decisions` -- the existing
 * human-authorized organizational decision lifecycle. An intervention with a
 * null decisionId was never authorized by a person, and cannot contribute to
 * a validated lesson however well it appeared to work.
 */
export interface PatternIntervention {
  readonly interventionId: string;
  readonly organizationId: string;
  readonly athleteId: string;
  readonly behaviourKey: string;
  readonly decisionId: string | null;
  readonly startedAt: string;
  /**
   * The task context the intervention was actually drilled in. Transfer is
   * defined against this: improvement in the drill you trained is training,
   * improvement somewhere you did not train is transfer.
   */
  readonly trainedTaskContextKey: string;
  readonly description: string;
}

/**
 * Reuses `pilot.shadow_decision_outcomes.match_state` verbatim rather than
 * introducing a second outcome vocabulary. `confounded` already exists there
 * and already means what this ladder needs it to mean: something else changed
 * at the same time, so the comparison does not support a conclusion.
 */
export type InterventionMatchState = 'match' | 'partial' | 'miss' | 'confounded';

export interface InterventionOutcomeReview {
  readonly outcomeId: string;
  readonly interventionId: string;
  readonly matchState: InterventionMatchState;
  /** Null until a person has actually reviewed it. Null blocks validation. */
  readonly reviewedByAccountId: string | null;
  readonly reviewedAt: string | null;
  readonly notes?: string;
}

export interface TransferEvidenceSummary {
  /** Post-intervention counterexamples outside the trained task context. */
  readonly count: number;
  readonly distinctTaskContexts: number;
  readonly taskContextKeys: readonly string[];
  readonly spansConstraintTypes: boolean;
}

export interface RetentionEvidenceSummary {
  /** Post-intervention counterexamples after the retention window elapsed. */
  readonly count: number;
  readonly distinctSessions: number;
  readonly windowElapsed: boolean;
  readonly latestAt: string | null;
}

/**
 * The end of the athlete ladder -- and deliberately not the end of anything
 * else. A validated lesson is a claim about ONE athlete, evidenced by their
 * own observations and one reviewed intervention on them.
 *
 * `generalizableToMethodology` is the literal `false` on every instance. A
 * lesson that held for one athlete is a single case; promoting it into PPBF
 * methodology is a separate, human, evidence-weighing act that this module
 * has no standing to perform. See `assertLessonIsNotMethodology`.
 */
export interface ValidatedAthleteLessonEvaluation {
  readonly lessonKey: string;
  readonly organizationId: string;
  readonly athleteId: string;
  readonly behaviourKey: string;

  readonly eligible: boolean;
  readonly blockers: readonly PatternReasonCode[];
  readonly warnings: readonly PatternReasonCode[];

  readonly transfer: TransferEvidenceSummary;
  readonly retention: RetentionEvidenceSummary;
  readonly outcomeMatchState: InterventionMatchState | null;

  readonly scope: 'athlete_specific';
  readonly generalizableToMethodology: false;
  readonly humanReviewRequired: true;

  readonly policyVersion: string;
  readonly policyRatifiedByAccountId: string;
  readonly evaluatedAt: string;

  /**
   * Single-case design comparison, present only when an SCD policy was
   * supplied. Null means the counting rules decided alone -- not that the
   * comparison ran and found nothing.
   *
   * Typed loosely for the same layering reason as
   * `PatternCandidateEvaluation.inference`; the concrete shape is
   * `SingleCaseAssessment`.
   */
  readonly singleCase: unknown | null;
}
