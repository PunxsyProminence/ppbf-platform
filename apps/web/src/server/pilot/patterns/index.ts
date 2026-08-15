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
