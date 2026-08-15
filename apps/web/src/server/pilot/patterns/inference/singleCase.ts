/**
 * Single-case design statistics: did this intervention do anything?
 *
 * WHY n=1 NEEDS ITS OWN STATISTICS. There is no control group and there never
 * will be -- this gym has one of each athlete. The athlete before the
 * intervention is the only honest comparison to the athlete after it, which is
 * the single-case design premise. Group statistics borrowed for n=1 answer a
 * question nobody asked.
 *
 * THE FAILURE MODE THIS EXISTS TO PREVENT. `lessons.ts` currently decides
 * transfer and retention by counting: fewer occurrences after than before.
 * Counting cannot tell the difference between an intervention that worked and
 * a kid who was already improving on their own before anyone intervened. Credit
 * the coaching for a trend that was already underway and the record now says a
 * cue works when it does not -- which is how a drill outlives the evidence for
 * it and gets taught to the next kid. Every method here is chosen to make that
 * specific mistake visible:
 *
 *   * Tau-U subtracts the baseline trend from the phase difference, so an
 *     already-falling baseline cannot be cashed in as an effect.
 *   * The baseline stability check refuses outright when the pre-phase is
 *     trending too hard to serve as a comparison at all.
 *   * The exact Mann-Whitney null distribution is enumerated rather than
 *     approximated, because at five observations a normal approximation is
 *     fiction and this ladder does not ship fiction.
 *
 * NO CAUSAL CLAIM IS AVAILABLE HERE. An AB comparison on an uncontrolled
 * series supports "consistent with an effect" and nothing stronger. The verdict
 * vocabulary says exactly that, and the human authorization gate in
 * `lessons.ts` remains where it is.
 */

import { assertPatternInferencePolicy, type PatternInferencePolicy } from './policy';

/**
 * Which way is better. A fault behaviour improves by becoming LESS frequent,
 * so the caller must say so -- inferring it from the data would mean deciding
 * that whichever direction the numbers moved was the desirable one.
 */
export type ImprovementDirection = 'decrease' | 'increase';

export type SingleCaseVerdict =
  | 'effect_supported'
  | 'no_effect_detected'
  | 'insufficient_evidence'
  | 'baseline_unstable';

export interface SingleCaseDesignPolicy {
  readonly policyVersion: string;
  readonly ratifiedByAccountId: string;
  readonly ratifiedAt: string;
  /** Sessions of pre-intervention record required before comparison is allowed. */
  readonly minimumBaselineObservations: number;
  readonly minimumTreatmentObservations: number;
  /** Nonoverlap (NAP) at or above which an effect is claimable. */
  readonly minimumNonoverlap: number;
  /** |Kendall tau| in the baseline above which the baseline cannot serve as one. */
  readonly maximumBaselineTrend: number;
  /** One-sided alpha for the exact test. */
  readonly significanceLevel: number;
}

export function assertSingleCaseDesignPolicy(policy: SingleCaseDesignPolicy): void {
  if (!policy || typeof policy !== 'object') {
    throw new TypeError('SCD_POLICY_MISSING: a single-case design policy is required.');
  }
  if (typeof policy.policyVersion !== 'string' || !policy.policyVersion.trim()) {
    throw new TypeError('Single-case design policy requires a policyVersion.');
  }
  if (typeof policy.ratifiedByAccountId !== 'string' || !policy.ratifiedByAccountId.trim()) {
    throw new TypeError(
      'Single-case design policy requires ratifiedByAccountId: an effect bar must be attributable to a person.',
    );
  }
  if (typeof policy.ratifiedAt !== 'string' || !Number.isFinite(Date.parse(policy.ratifiedAt))) {
    throw new TypeError('Single-case design policy requires a valid ratifiedAt timestamp.');
  }
  if (!Number.isInteger(policy.minimumBaselineObservations) || policy.minimumBaselineObservations < 3) {
    throw new TypeError(
      'minimumBaselineObservations must be at least 3: two points cannot show whether a baseline is stable.',
    );
  }
  if (!Number.isInteger(policy.minimumTreatmentObservations) || policy.minimumTreatmentObservations < 3) {
    throw new TypeError('minimumTreatmentObservations must be at least 3.');
  }
  for (const [name, value] of [
    ['minimumNonoverlap', policy.minimumNonoverlap],
    ['maximumBaselineTrend', policy.maximumBaselineTrend],
    ['significanceLevel', policy.significanceLevel],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0 || value >= 1) {
      throw new TypeError(`${name} must be strictly between 0 and 1.`);
    }
  }
}

// ── nonparametric primitives ────────────────────────────────────────────────

/**
 * Kendall's tau over (index, value): the baseline's own trend.
 *
 * Rank-based rather than a fitted slope, because a slope assumes a functional
 * form that four session rates cannot support, and one outlying session would
 * swing it.
 */
export function kendallTau(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let concordant = 0;
  let discordant = 0;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const difference = Math.sign(values[j] - values[i]);
      if (difference > 0) concordant += 1;
      else if (difference < 0) discordant += 1;
      // Ties contribute to neither, and stay in the denominator: a flat
      // stretch is evidence of stability, not missing evidence.
    }
  }
  return (concordant - discordant) / ((n * (n - 1)) / 2);
}

export interface NonoverlapResult {
  /** Nonoverlap of All Pairs, in [0,1]. 0.5 is chance. */
  readonly nap: number;
  /** Pairs favouring improvement, ties counted as half. */
  readonly improvedPairs: number;
  readonly totalPairs: number;
}

/**
 * NAP -- the share of baseline/treatment pairs in which the treatment session
 * was better. Equivalent to the AUC and to Mann-Whitney U, which is why the
 * exact test below can reuse the same statistic.
 */
export function nonoverlapOfAllPairs(
  baseline: readonly number[],
  treatment: readonly number[],
  direction: ImprovementDirection,
): NonoverlapResult {
  let improved = 0;
  for (const before of baseline) {
    for (const after of treatment) {
      const delta = direction === 'decrease' ? before - after : after - before;
      if (delta > 0) improved += 1;
      else if (delta === 0) improved += 0.5;
    }
  }
  const totalPairs = baseline.length * treatment.length;
  return Object.freeze({
    nap: totalPairs === 0 ? 0.5 : improved / totalPairs,
    improvedPairs: improved,
    totalPairs,
  });
}

/**
 * Tau-U with baseline-trend correction (Parker et al.).
 *
 * The numerator is the phase contrast MINUS the baseline's own drift, so an
 * athlete who was already improving before anyone intervened does not hand the
 * intervention credit for it. This is the single most important number in the
 * module.
 */
export function tauU(
  baseline: readonly number[],
  treatment: readonly number[],
  direction: ImprovementDirection,
): number {
  const sign = direction === 'decrease' ? -1 : 1;

  let phaseContrast = 0;
  for (const before of baseline) {
    for (const after of treatment) {
      phaseContrast += sign * Math.sign(after - before);
    }
  }

  let baselineDrift = 0;
  for (let i = 0; i < baseline.length; i += 1) {
    for (let j = i + 1; j < baseline.length; j += 1) {
      baselineDrift += sign * Math.sign(baseline[j] - baseline[i]);
    }
  }

  const denominator = (baseline.length * treatment.length)
    + ((baseline.length * (baseline.length - 1)) / 2);
  if (denominator === 0) return 0;
  return (phaseContrast - baselineDrift) / denominator;
}

/**
 * Exact one-sided p-value for Mann-Whitney U by enumerating the null
 * distribution.
 *
 * EXACT, NOT APPROXIMATE. The normal approximation needs roughly twenty per
 * phase to be trustworthy and this module's phases are five. Counting the
 * arrangements is cheap at these sizes and is correct at every size, so there
 * is no reason to approximate and every reason not to: an approximate p-value
 * at n=5 would be a confident-looking number with nothing behind it.
 *
 * Ties are handled conservatively -- a tie contributes half a pair to the
 * observed statistic but the null distribution is the untied one, which biases
 * the p-value UPWARD (toward finding no effect). Erring toward "we did not
 * detect anything" is the correct direction to be wrong in.
 */
export function exactMannWhitneyP(
  baselineSize: number,
  treatmentSize: number,
  improvedPairs: number,
): number {
  if (baselineSize === 0 || treatmentSize === 0) return 1;

  // counts[u] = number of arrangements yielding U = u, which is the Gaussian
  // binomial coefficient [m+n choose m]_q. Built as the product over i of
  // (1 - q^(n+i)) / (1 - q^i): the multiplication is a shifted subtraction and
  // the division is a strided prefix sum, both exact in integer arithmetic at
  // these sizes.
  const maximum = baselineSize * treatmentSize;
  const counts = new Float64Array(maximum + 1);
  counts[0] = 1;

  for (let i = 1; i <= baselineSize; i += 1) {
    const shift = treatmentSize + i;
    for (let u = maximum; u >= shift; u -= 1) counts[u] -= counts[u - shift];
    for (let u = i; u <= maximum; u += 1) counts[u] += counts[u - i];
  }

  let total = 0;
  for (let u = 0; u <= maximum; u += 1) total += counts[u];

  // P(U >= observed) under the null of no phase difference.
  //
  // floor(), not ceil(): a half-pair from a tie is rounded DOWN, which widens
  // the tail and raises the p-value. Erring toward "we did not detect
  // anything" is the correct direction to be wrong in.
  const threshold = Math.floor(improvedPairs);
  let atLeastObserved = 0;
  for (let u = threshold; u <= maximum; u += 1) atLeastObserved += counts[u];

  return total === 0 ? 1 : Math.min(1, atLeastObserved / total);
}

// ── assessment ──────────────────────────────────────────────────────────────

export interface SingleCaseAssessment {
  readonly baselineSize: number;
  readonly treatmentSize: number;
  readonly baselineTrend: number;
  readonly baselineStable: boolean;
  readonly nonoverlap: NonoverlapResult;
  readonly tauU: number;
  readonly exactP: number;
  readonly verdict: SingleCaseVerdict;
  readonly reasons: readonly string[];
  readonly policyVersion: string;
}

/**
 * Compares a pre-intervention series against a post-intervention series.
 *
 * Both series are per-session rates the caller has already derived from
 * observations it admitted; nothing here reads storage or a clock.
 */
export function assessSingleCaseDesign(
  input: {
    readonly baseline: readonly number[];
    readonly treatment: readonly number[];
    readonly direction: ImprovementDirection;
  },
  policy: SingleCaseDesignPolicy,
): SingleCaseAssessment {
  assertSingleCaseDesignPolicy(policy);

  const { baseline, treatment, direction } = input;
  if (!Array.isArray(baseline) || !Array.isArray(treatment)) {
    throw new TypeError('assessSingleCaseDesign requires baseline and treatment series.');
  }
  if (direction !== 'decrease' && direction !== 'increase') {
    throw new TypeError(
      'assessSingleCaseDesign requires an explicit improvement direction: which way is better is not inferable from the data.',
    );
  }
  for (const value of [...baseline, ...treatment]) {
    if (!Number.isFinite(value)) {
      throw new TypeError('Series values must be finite numbers; absence is not a value.');
    }
  }

  const baselineTrend = kendallTau(baseline);
  const nonoverlap = nonoverlapOfAllPairs(baseline, treatment, direction);
  const effect = tauU(baseline, treatment, direction);
  const exactP = exactMannWhitneyP(baseline.length, treatment.length, nonoverlap.improvedPairs);

  const reasons: string[] = [];
  let verdict: SingleCaseVerdict;

  if (baseline.length < policy.minimumBaselineObservations
    || treatment.length < policy.minimumTreatmentObservations) {
    reasons.push('SCD_PHASE_TOO_SHORT');
    verdict = 'insufficient_evidence';
  } else if (Math.abs(baselineTrend) > policy.maximumBaselineTrend) {
    // The athlete was already moving. Nothing after the intervention can be
    // separated from what was happening before it.
    reasons.push('SCD_BASELINE_UNSTABLE');
    verdict = 'baseline_unstable';
  } else if (exactP <= policy.significanceLevel && nonoverlap.nap >= policy.minimumNonoverlap) {
    verdict = 'effect_supported';
  } else {
    if (exactP > policy.significanceLevel) reasons.push('SCD_NOT_SIGNIFICANT');
    if (nonoverlap.nap < policy.minimumNonoverlap) reasons.push('SCD_NONOVERLAP_BELOW_POLICY');
    verdict = 'no_effect_detected';
  }

  return Object.freeze({
    baselineSize: baseline.length,
    treatmentSize: treatment.length,
    baselineTrend,
    baselineStable: Math.abs(baselineTrend) <= policy.maximumBaselineTrend,
    nonoverlap,
    tauU: effect,
    exactP,
    verdict,
    reasons: Object.freeze(reasons),
    policyVersion: policy.policyVersion,
  });
}

/** Re-exported so callers can hold one import for the inference lane. */
export type { PatternInferencePolicy };
export { assertPatternInferencePolicy };
