/**
 * The injected, ratified bar for Phase A inference.
 *
 * Same contract as `../policy.ts`: no defaults anywhere, a version string, and
 * the account that ratified it, so every number is attributable to a person
 * who can be asked why. `assertPatternInferencePolicy` throws on an absent or
 * incoherent policy rather than substituting a working one -- an inference
 * that ran against a bar nobody set is worse than one that refused to run.
 *
 * Nothing in this file proposes values. The ranges below are coherence checks
 * (a probability is a probability, an EWMA weight is in (0,1]); they do not
 * express an opinion about where a bar belongs.
 */

export interface RecurrencePriorPolicy {
  /**
   * Gym-level prior as pseudo-counts, the empirical-Bayes shrinkage target.
   *
   * A thin-evidence athlete is pulled toward this; as their own observation
   * count grows it dominates and the prior's influence fades. That direction
   * is a property of conjugate updating, not a separate mechanism -- see
   * `recurrence.ts`.
   *
   * These are counts, so they may be fractional but must be positive: a zero
   * would make the posterior improper at the boundary.
   */
  readonly priorOccurrences: number;
  readonly priorNonOccurrences: number;
}

export interface SequentialTestPolicy {
  /** Rate under the null: "this is background noise, not a pattern." */
  readonly nullRate: number;
  /** Rate under the alternative: "this recurs often enough to matter." */
  readonly alternativeRate: number;
  /** Tolerated probability of promoting a non-pattern. */
  readonly falsePromotionRate: number;
  /** Tolerated probability of rejecting a real pattern. */
  readonly missedPatternRate: number;
}

export interface PosteriorWidthPolicy {
  /** Credible mass the interval must cover, e.g. 0.9. */
  readonly credibleMass: number;
  /**
   * Widest credible interval that still counts as having said something.
   * Above this the candidate reports POSTERIOR_TOO_WIDE -- the honest reading
   * of "we have three observations and the rate could be almost anything".
   */
  readonly maximumCredibleWidth: number;
}

export interface StratifiedAttributionPolicy {
  /**
   * Dirichlet concentration applied to every attribution target, i.e. a
   * symmetric prior. Symmetric because the model has no business assuming, in
   * advance, that a failure is more likely the athlete's than the room's.
   */
  readonly concentration: number;
  /**
   * Minimum occurrences in a stratum before it may disagree with another.
   * Below this the stratum is reported as thin rather than dissenting; one
   * observation in a fatigued round is not a second opinion.
   */
  readonly minimumStratumSize: number;
}

export interface DriftPolicy {
  /** EWMA smoothing weight in (0, 1]; larger reacts faster to recent sessions. */
  readonly ewmaLambda: number;
  /** CUSUM slack, in units of the monitored rate. Absorbs ordinary variation. */
  readonly cusumSlack: number;
  /** CUSUM decision interval. A cumulative sum beyond this flags a shift. */
  readonly cusumThreshold: number;
  /** Sessions of history required before drift is assessed at all. */
  readonly minimumHistorySessions: number;
}

export interface PatternInferencePolicy {
  readonly policyVersion: string;
  readonly ratifiedByAccountId: string;
  readonly ratifiedAt: string;

  readonly recurrencePrior: RecurrencePriorPolicy;
  readonly sequentialTest: SequentialTestPolicy;
  readonly posteriorWidth: PosteriorWidthPolicy;
  readonly stratifiedAttribution: StratifiedAttributionPolicy;
  readonly drift: DriftPolicy;
}

function isPositiveFinite(value: unknown): boolean {
  return Number.isFinite(value) && (value as number) > 0;
}

function isStrictProbability(value: unknown): boolean {
  return Number.isFinite(value) && (value as number) > 0 && (value as number) < 1;
}

export function assertPatternInferencePolicy(policy: PatternInferencePolicy): void {
  if (!policy || typeof policy !== 'object') {
    throw new TypeError('INFERENCE_POLICY_MISSING: a pattern inference policy is required.');
  }
  if (typeof policy.policyVersion !== 'string' || !policy.policyVersion.trim()) {
    throw new TypeError('Pattern inference policy requires a policyVersion.');
  }
  if (typeof policy.ratifiedByAccountId !== 'string' || !policy.ratifiedByAccountId.trim()) {
    throw new TypeError(
      'Pattern inference policy requires ratifiedByAccountId: an inference bar must be attributable to a person.',
    );
  }
  if (typeof policy.ratifiedAt !== 'string' || !Number.isFinite(Date.parse(policy.ratifiedAt))) {
    throw new TypeError('Pattern inference policy requires a valid ratifiedAt timestamp.');
  }

  const prior = policy.recurrencePrior;
  if (!prior || !isPositiveFinite(prior.priorOccurrences) || !isPositiveFinite(prior.priorNonOccurrences)) {
    throw new TypeError('recurrencePrior requires positive pseudo-counts for both outcomes.');
  }

  const test = policy.sequentialTest;
  if (!test
    || !isStrictProbability(test.nullRate)
    || !isStrictProbability(test.alternativeRate)
    || !isStrictProbability(test.falsePromotionRate)
    || !isStrictProbability(test.missedPatternRate)) {
    throw new TypeError('sequentialTest rates must all be strictly between 0 and 1.');
  }
  if (test.alternativeRate <= test.nullRate) {
    throw new TypeError(
      'sequentialTest is incoherent: alternativeRate must exceed nullRate, or the test has nothing to discriminate.',
    );
  }
  if (test.falsePromotionRate + test.missedPatternRate >= 1) {
    throw new TypeError('sequentialTest error rates must sum to less than 1.');
  }

  const width = policy.posteriorWidth;
  if (!width || !isStrictProbability(width.credibleMass)) {
    throw new TypeError('posteriorWidth.credibleMass must be strictly between 0 and 1.');
  }
  if (!isStrictProbability(width.maximumCredibleWidth)) {
    throw new TypeError('posteriorWidth.maximumCredibleWidth must be strictly between 0 and 1.');
  }

  const strata = policy.stratifiedAttribution;
  if (!strata || !isPositiveFinite(strata.concentration)) {
    throw new TypeError('stratifiedAttribution.concentration must be positive.');
  }
  if (!Number.isInteger(strata.minimumStratumSize) || strata.minimumStratumSize < 1) {
    throw new TypeError('stratifiedAttribution.minimumStratumSize must be an integer of at least 1.');
  }

  const drift = policy.drift;
  if (!drift || !Number.isFinite(drift.ewmaLambda) || drift.ewmaLambda <= 0 || drift.ewmaLambda > 1) {
    throw new TypeError('drift.ewmaLambda must be in (0, 1].');
  }
  if (!Number.isFinite(drift.cusumSlack) || drift.cusumSlack < 0) {
    throw new TypeError('drift.cusumSlack must be zero or positive.');
  }
  if (!isPositiveFinite(drift.cusumThreshold)) {
    throw new TypeError('drift.cusumThreshold must be positive.');
  }
  if (!Number.isInteger(drift.minimumHistorySessions) || drift.minimumHistorySessions < 2) {
    throw new TypeError(
      'drift.minimumHistorySessions must be at least 2: a single session cannot show a trend.',
    );
  }
}

/** Stamped into results so a stored inference records the bar it used. */
export function inferencePolicyParameters(
  policy: PatternInferencePolicy,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    recurrencePrior: Object.freeze({ ...policy.recurrencePrior }),
    sequentialTest: Object.freeze({ ...policy.sequentialTest }),
    posteriorWidth: Object.freeze({ ...policy.posteriorWidth }),
    stratifiedAttribution: Object.freeze({ ...policy.stratifiedAttribution }),
    drift: Object.freeze({ ...policy.drift }),
  });
}
