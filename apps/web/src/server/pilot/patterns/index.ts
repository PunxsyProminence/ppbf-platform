/**
 * SHADOW behavioural pattern formation.
 *
 * Pure, deterministic, and persistence-free by design: no DDL, no queries, no
 * HTTP, no authorization decisions. Wiring these functions to real data is a
 * later, separately-reviewed slice -- what lands here is the algorithm and the
 * boundaries it holds.
 *
 * Entry points:
 *   evaluatePatternCandidate      Observation[] -> epistemic standing
 *   evaluateValidatedAthleteLesson  intervention + reviewed outcome -> lesson
 *   assertLessonIsNotMethodology  the refusal that ends the ladder
 */

export type {
  AttributionCertainty,
  AttributionSummary,
  AttributionTarget,
  BehaviourObservation,
  ContextDiversitySummary,
  CounterEvidenceSummary,
  FatigueContext,
  InterpretationOrigin,
  InterventionMatchState,
  InterventionOutcomeReview,
  ObservationAttribution,
  ObservationPolarity,
  ObservationSource,
  ObservationSourceType,
  PatternCandidateEvaluation,
  PatternEpistemicState,
  PatternEvidenceSummary,
  PatternIntervention,
  PatternObservationProvenance,
  PatternPromotionProposal,
  PatternReasonCode,
  RetentionEvidenceSummary,
  SourceQuality,
  TaskConstraint,
  TransferEvidenceSummary,
  ValidatedAthleteLessonEvaluation,
} from './types';

export { isAbstention } from './types';

export {
  assertPatternFormationPolicy,
  policyParameters,
  type PatternFormationPolicy,
} from './policy';

export {
  admitObservations,
  detectObserverDisagreement,
  detectVideoContradiction,
  recentOccurrenceCount,
  summarizeAttribution,
  summarizeContextDiversity,
  summarizeCounterEvidence,
  summarizeEvidence,
  toProvenance,
  type ObservationAdmission,
  type ObservationScope,
} from './evidence';

export {
  evaluatePatternCandidate,
  type EvaluatePatternCandidateInput,
} from './promotion';

export {
  assertAthleteLessonPolicy,
  assertLessonIsNotMethodology,
  evaluateValidatedAthleteLesson,
  summarizeRetentionEvidence,
  summarizeTransferEvidence,
  type AthleteLessonPolicy,
  type EvaluateAthleteLessonInput,
} from './lessons';

// ── Phase A inference (Stack v1.1 §2.2-§2.5) ────────────────────────────────
// Closed-form only: no service, no training, no runtime math dependency.
export {
  betaCredibleInterval,
  betaQuantile,
  betaTailAbove,
  logBeta,
  logGamma,
  regularizedIncompleteBeta,
  type CredibleInterval,
} from './inference/beta';

export {
  assertPatternInferencePolicy,
  inferencePolicyParameters,
  type DriftPolicy,
  type PatternInferencePolicy,
  type PosteriorWidthPolicy,
  type RecurrencePriorPolicy,
  type SequentialTestPolicy,
  type StratifiedAttributionPolicy,
} from './inference/policy';

export {
  assessRecurrence,
  type RecurrenceAssessment,
  type RecurrenceObservationCounts,
  type SequentialVerdict,
} from './inference/recurrence';

export {
  assessStratifiedAttribution,
  type StratifiedAttributionAssessment,
  type StratumAxis,
  type StratumSummary,
} from './inference/attribution';

export {
  assessDrift,
  buildSessionRateSeries,
  type DriftAssessment,
  type SessionRatePoint,
} from './inference/drift';

export type { PatternInferenceReport } from './promotion';

// ── Single-case design (n=1 intervention evaluation) ────────────────────────
export {
  assertSingleCaseDesignPolicy,
  assessSingleCaseDesign,
  exactMannWhitneyP,
  kendallTau,
  nonoverlapOfAllPairs,
  tauU,
  type ImprovementDirection,
  type NonoverlapResult,
  type SingleCaseAssessment,
  type SingleCaseDesignPolicy,
  type SingleCaseVerdict,
} from './inference/singleCase';

// ── Observer reliability (measurement validity) ─────────────────────────────
export {
  assertObserverReliabilityPolicy,
  assessObserverReliability,
  type CoRatedItem,
  type ObserverDeviation,
  type ObserverReliabilityAssessment,
  type ObserverReliabilityPolicy,
  type ReliabilityVerdict,
} from './inference/reliability';
