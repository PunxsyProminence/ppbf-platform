/**
 * Stack v1.1 §2.4 -- stratified attribution.
 *
 * THE QUESTION the strata answer: is this one behaviour, or is it several
 * different situations wearing the same name? A pooled attribution tally can
 * say "70% athlete" while concealing that every athlete-attributed occurrence
 * came from fatigued rounds and every fresh round pointed at the coach's cue.
 * Splitting by axis and comparing is what makes that visible.
 *
 * DISAGREEMENT IS A SUCCESSFUL OUTPUT. When two adequately-sized strata name
 * different culprits, this reports `STRATA_DISAGREEMENT` and the candidate
 * resolves to ATTRIBUTION_UNRESOLVED. That is the correct answer, not a
 * failure to decide: the evidence genuinely does not identify one target, and
 * picking the larger pile would be manufacturing a verdict.
 *
 * THE LOAD TEST USES INTERVALS, NOT A MARGIN. "The behaviour appears under
 * fatigue" is claimed only when the fatigued stratum's credible interval sits
 * entirely above the fresh stratum's -- non-overlapping intervals. That is a
 * comparison with no invented threshold in it: a margin like "0.3 higher"
 * would be exactly the fake precision this ladder exists to avoid, and would
 * fire on two observations.
 *
 * Dirichlet concentration is SYMMETRIC across targets by policy contract. The
 * model has no business assuming in advance that a failure is more likely the
 * athlete's than the room's.
 */

import type { AttributionTarget, BehaviourObservation, PatternReasonCode } from '../types';
import { ATTRIBUTION_TARGETS } from '../evidence';
import { betaCredibleInterval, type CredibleInterval } from './beta';
import { assertPatternInferencePolicy, type PatternInferencePolicy } from './policy';

export type StratumAxis =
  | 'task_constraint'
  | 'fatigue_context'
  | 'task_context'
  | 'observer';

export interface StratumSummary {
  readonly axis: StratumAxis;
  /** The stratum's value on that axis, e.g. 'fatigued' or 'task-mitts'. */
  readonly key: string;
  /** Opportunities in this stratum: occurrences + counterexamples. */
  readonly trials: number;
  readonly occurrences: number;
  /** Dirichlet posterior mean per attribution target, summing to 1. */
  readonly attributionPosterior: Readonly<Record<AttributionTarget, number>>;
  /** Highest-posterior target, or null on a tie. */
  readonly leadingTarget: AttributionTarget | null;
  /** Beta posterior for the occurrence rate within this stratum. */
  readonly rateInterval: CredibleInterval;
  readonly rateMean: number;
  /** False when the stratum is too thin to count as a second opinion. */
  readonly eligible: boolean;
}

export interface StratifiedAttributionAssessment {
  readonly strata: readonly StratumSummary[];
  readonly eligibleStrataCount: number;
  /** Axes on which two eligible strata name different targets. */
  readonly disagreeingAxes: readonly StratumAxis[];
  readonly disagreement: boolean;
  /**
   * True when occurrences concentrate in a heavier-load stratum, with
   * non-overlapping intervals. The claim is about load, not the athlete.
   */
  readonly loadImplicated: boolean;
  readonly reasons: readonly PatternReasonCode[];
}

const FATIGUE_ORDER: readonly string[] = ['fresh', 'moderate', 'fatigued'];

function axisKey(observation: BehaviourObservation, axis: StratumAxis): string | null {
  switch (axis) {
    case 'task_constraint':
      return observation.taskConstraint;
    case 'fatigue_context':
      // 'unknown' is not a stratum. Comparing against it would treat a gap in
      // the record as a condition the athlete was in.
      return observation.fatigueContext === 'unknown' ? null : observation.fatigueContext;
    case 'task_context':
      return observation.taskContextKey;
    case 'observer':
      return observation.observerAccountId;
    default:
      return null;
  }
}

function summarizeStratum(
  axis: StratumAxis,
  key: string,
  members: readonly BehaviourObservation[],
  policy: PatternInferencePolicy,
): StratumSummary {
  const occurrences = members.filter((item) => item.polarity === 'occurrence');
  const { concentration, minimumStratumSize } = policy.stratifiedAttribution;

  const counts = Object.fromEntries(
    ATTRIBUTION_TARGETS.map((target) => [target, 0]),
  ) as Record<AttributionTarget, number>;
  for (const observation of occurrences) {
    counts[observation.attribution.target] += 1;
  }

  const denominator = occurrences.length + (concentration * ATTRIBUTION_TARGETS.length);
  const attributionPosterior = Object.fromEntries(
    ATTRIBUTION_TARGETS.map((target) => [target, (counts[target] + concentration) / denominator]),
  ) as Record<AttributionTarget, number>;

  const ranked = ATTRIBUTION_TARGETS
    .map((target) => ({ target, mass: attributionPosterior[target] }))
    .sort((left, right) => right.mass - left.mass);
  // A tie has no leader; inventing one out of alphabetical order would turn a
  // genuine split into a finding.
  const leadingTarget = occurrences.length > 0 && ranked[0].mass > ranked[1].mass
    ? ranked[0].target
    : null;

  const { priorOccurrences, priorNonOccurrences } = policy.recurrencePrior;
  const alpha = priorOccurrences + occurrences.length;
  const beta = priorNonOccurrences + (members.length - occurrences.length);

  return Object.freeze({
    axis,
    key,
    trials: members.length,
    occurrences: occurrences.length,
    attributionPosterior: Object.freeze(attributionPosterior),
    leadingTarget,
    rateInterval: betaCredibleInterval(alpha, beta, policy.posteriorWidth.credibleMass),
    rateMean: alpha / (alpha + beta),
    eligible: members.length >= minimumStratumSize,
  });
}

export function assessStratifiedAttribution(
  observations: readonly BehaviourObservation[],
  policy: PatternInferencePolicy,
): StratifiedAttributionAssessment {
  assertPatternInferencePolicy(policy);

  const axes: readonly StratumAxis[] = ['task_constraint', 'fatigue_context', 'task_context', 'observer'];
  const strata: StratumSummary[] = [];

  for (const axis of axes) {
    const groups = new Map<string, BehaviourObservation[]>();
    for (const observation of observations) {
      const key = axisKey(observation, axis);
      if (key == null) continue;
      const group = groups.get(key);
      if (group) group.push(observation);
      else groups.set(key, [observation]);
    }
    // Sorted so the output is byte-identical regardless of input order.
    for (const key of [...groups.keys()].sort()) {
      strata.push(summarizeStratum(axis, key, groups.get(key)!, policy));
    }
  }

  const disagreeingAxes: StratumAxis[] = [];
  for (const axis of axes) {
    const leaders = strata
      .filter((stratum) => stratum.axis === axis && stratum.eligible && stratum.leadingTarget != null)
      .map((stratum) => stratum.leadingTarget);
    if (new Set(leaders).size > 1) {
      disagreeingAxes.push(axis);
    }
  }

  // Load test: a heavier fatigue stratum whose occurrence-rate interval sits
  // entirely above a lighter one's. Non-overlapping intervals, no margin.
  const fatigueStrata = strata.filter(
    (stratum) => stratum.axis === 'fatigue_context' && stratum.eligible,
  );
  let loadImplicated = false;
  for (const heavier of fatigueStrata) {
    for (const lighter of fatigueStrata) {
      const heavierRank = FATIGUE_ORDER.indexOf(heavier.key);
      const lighterRank = FATIGUE_ORDER.indexOf(lighter.key);
      if (heavierRank <= lighterRank) continue;
      if (heavier.rateInterval.lower > lighter.rateInterval.upper) {
        loadImplicated = true;
      }
    }
  }

  const reasons: PatternReasonCode[] = [];
  if (disagreeingAxes.length > 0) reasons.push('STRATA_DISAGREEMENT');
  if (loadImplicated) reasons.push('LOAD_STRATUM_IMPLICATED');

  return Object.freeze({
    strata: Object.freeze(strata),
    eligibleStrataCount: strata.filter((stratum) => stratum.eligible).length,
    disagreeingAxes: Object.freeze(disagreeingAxes),
    disagreement: disagreeingAxes.length > 0,
    loadImplicated,
    reasons: Object.freeze(reasons),
  });
}
