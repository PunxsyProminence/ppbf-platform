/**
 * Stored behaviour reports into the tier engine (PATTERN-1b,
 * PunxsyProminence/ppbf-platform#2082). Pure: patternStanding.ts reads the
 * rows and the gym's bars in force, and this turns them into one call of
 * evaluatePatternTiers.
 *
 * THE STORED EPISODE IS THE ATTEMPT (LL-W4). pilot.behaviour_observations
 * keeps one episode per attempt and behaviour, fixed to one athlete, session
 * and context by the table's guard. The engine's attempt is its
 * `opportunityKey` within a session and context, so the episode id is passed
 * as that key and the session key as the session. Without it every report
 * would be an attempt of its own, two coaches' reports of one rep would never
 * be a paired judgment, and no pair could ever be calibrated.
 *
 * The gym is the row's own, so the engine's scope check can refuse another
 * gym's row. What is not carried: the coach's note (free text the engine never
 * reads).
 *
 * NO BAR IN FORCE, NO EVALUATION. Without a ratified pattern bar there are no
 * numbers to judge by, so nothing is evaluated and the reason is returned. A
 * stored bar that is not its kind's shape is not used, and says so. A missing
 * calibration bar is the engine's case: it evaluates, nothing counts, and the
 * evaluation says no calibration bar is in force (Q1 A). The bars are the ones
 * in force now; `asOf` sets the evidence window, not which bar applied then.
 */

import type { ObservationSourceType, SourceQuality } from '../formulas/types';
import {
  barFor,
  type LearningPolicyRow,
  type ObserverCalibrationBar,
  type PatternFormationBar,
  type PolicyKind,
} from '../learningPolicies';
import { evaluatePatternTiers, type PatternTierEvaluation } from './tiers';
import type {
  AttributionCertainty,
  AttributionTarget,
  BehaviourObservation,
  FatigueContext,
  InterpretationOrigin,
  ObservationPolarity,
  TaskConstraint,
} from './types';

/** One stored report as the tier read selects it (behaviourObservations.ts listBehaviourReadingsForEvaluation). */
export interface StoredBehaviourReading {
  observation_id: string;
  organization_id: string;
  athlete_id: string;
  behaviour_key: string;
  episode_id: string;
  session_key: string;
  task_context_key: string;
  task_constraint: TaskConstraint;
  fatigue_context: FatigueContext;
  polarity: ObservationPolarity;
  attribution_target: AttributionTarget;
  attribution_certainty: AttributionCertainty;
  source_type: ObservationSourceType;
  source_quality: SourceQuality;
  interpretation: InterpretationOrigin;
  observer_account_id: string | null;
  supersedes_observation_id: string | null;
  /** timestamptz: node-postgres returns a Date. */
  observed_at: string | Date;
}

export function observationFromStored(row: StoredBehaviourReading): BehaviourObservation {
  const at = new Date(row.observed_at);
  return Object.freeze({
    observationId: row.observation_id,
    organizationId: row.organization_id,
    athleteId: row.athlete_id,
    behaviourKey: row.behaviour_key,
    sessionId: row.session_key,
    taskContextKey: row.task_context_key,
    taskConstraint: row.task_constraint,
    fatigueContext: row.fatigue_context,
    // An unreadable time is passed as it came, for the engine to refuse (INVALID_TIMESTAMP).
    observedAt: Number.isNaN(at.getTime()) ? String(row.observed_at) : at.toISOString(),
    opportunityKey: row.episode_id,
    source: Object.freeze({
      type: row.source_type, quality: row.source_quality, referenceId: `behaviour_observation:${row.observation_id}`,
    }),
    observerAccountId: row.observer_account_id,
    interpretation: row.interpretation,
    polarity: row.polarity,
    attribution: Object.freeze({ target: row.attribution_target, certainty: row.attribution_certainty }),
    supersedesObservationId: row.supersedes_observation_id,
  });
}

export type NotEvaluatedReason = 'no_pattern_bar_in_force' | 'pattern_bar_unreadable' | 'calibration_bar_unreadable';

export interface BarInForce {
  readonly policyId: string;
  readonly version: number;
}

export interface StoredPatternStanding {
  readonly organizationId: string;
  readonly athleteId: string;
  readonly behaviourKey: string;
  readonly asOf: string;
  readonly bars: Readonly<{ pattern: BarInForce | null; calibration: BarInForce | null }>;
  /** Why there is no evaluation; null when there is one. */
  readonly notEvaluated: NotEvaluatedReason | null;
  readonly evaluation: PatternTierEvaluation | null;
}

/** The newest version in force of one kind, or null. */
export function barInForce(policies: readonly LearningPolicyRow[], kind: PolicyKind): LearningPolicyRow | null {
  return policies
    .filter((policy) => policy.policy_kind === kind && policy.status === 'active')
    .sort((left, right) => right.version - left.version)[0] ?? null;
}

function readable<T>(kind: PolicyKind, policy: LearningPolicyRow): T | null {
  try {
    return barFor(kind, policy.parameters) as T;
  } catch {
    return null;
  }
}

/** The bars a standing would use, or why there is no evaluation: decided before any report is read. */
export function standingBars(activePolicies: readonly LearningPolicyRow[]): {
  readonly notEvaluated: NotEvaluatedReason | null;
  readonly bars: Readonly<{ pattern: BarInForce | null; calibration: BarInForce | null }>;
  readonly bar: PatternFormationBar | null;
  readonly calibration: ObserverCalibrationBar | null;
} {
  const patternPolicy = barInForce(activePolicies, 'pattern_formation');
  const calibrationPolicy = barInForce(activePolicies, 'observer_calibration');
  const named = (policy: LearningPolicyRow | null): BarInForce | null => (
    policy ? Object.freeze({ policyId: policy.policy_id, version: policy.version }) : null);
  const bars = Object.freeze({ pattern: named(patternPolicy), calibration: named(calibrationPolicy) });
  const bar = patternPolicy ? readable<PatternFormationBar>('pattern_formation', patternPolicy) : null;
  const calibration = calibrationPolicy ? readable<ObserverCalibrationBar>('observer_calibration', calibrationPolicy) : null;
  const notEvaluated: NotEvaluatedReason | null = !patternPolicy ? 'no_pattern_bar_in_force'
    : !bar ? 'pattern_bar_unreadable'
      : calibrationPolicy && !calibration ? 'calibration_bar_unreadable'
        : null;
  return Object.freeze({ notEvaluated, bars, bar: notEvaluated ? null : bar, calibration: notEvaluated ? null : calibration });
}

export function evaluateStoredPatternStanding(input: {
  organizationId: string;
  athleteId: string;
  behaviourKey: string;
  asOf: string;
  activePolicies: readonly LearningPolicyRow[];
  /** The gym's stored reports of this behaviour, every athlete (they judge the coach pairs). */
  gymReadings: readonly StoredBehaviourReading[];
}): StoredPatternStanding {
  const { notEvaluated, bars, bar, calibration } = standingBars(input.activePolicies);
  const outcome = (evaluation: PatternTierEvaluation | null) => Object.freeze({
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    behaviourKey: input.behaviourKey,
    asOf: input.asOf,
    bars,
    notEvaluated,
    evaluation,
  });
  if (notEvaluated || !bar) return outcome(null);

  const readings = input.gymReadings
    .filter((row) => row.behaviour_key === input.behaviourKey)
    .map(observationFromStored);
  return outcome(evaluatePatternTiers({
    organizationId: input.organizationId,
    athleteId: input.athleteId,
    behaviourKey: input.behaviourKey,
    observations: readings.filter((reading) => reading.athleteId === input.athleteId),
    calibrationReadings: readings,
    bar,
    calibration,
    asOf: input.asOf,
  }));
}
