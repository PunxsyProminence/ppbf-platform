/**
 * Stack v1.1 §2.2 (conjugate recurrence) and §2.3 (sequential promotion).
 *
 * THE QUESTION: given that the opportunity arose n times and the behaviour
 * occurred k of them, does this behaviour actually recur -- or have we watched
 * too little to tell?
 *
 * WHAT COUNTS AS A TRIAL. An opportunity is an observation of this behaviour
 * key, either polarity: an occurrence is a success, a counterexample is a
 * failure. Absence is NOT a trial. Nobody may have been watching, the athlete
 * may not have been there, and the drill may never have created the chance --
 * so counting un-observed sessions as failures would manufacture evidence of
 * improvement out of a gap in the record. This is the same rule `lessons.ts`
 * applies to post-intervention improvement, for the same reason.
 *
 * WHY CONJUGATE. Beta-Binomial is the exact posterior in closed form, so it
 * runs as pure TypeScript with no service, no training, and no seed. At this
 * gym's data volume -- dozens of athletes, a handful of observations each --
 * an honest posterior beats a fitted model, because the thing that most needs
 * saying is "the interval is still enormous", and only a posterior can say it.
 *
 * SHRINKAGE DIRECTION. The gym prior enters as pseudo-counts, so a thin-data
 * athlete is pulled toward the gym rate and un-shrinks toward their own rate
 * as observations accumulate. That is a property of the conjugate update, not
 * a second mechanism bolted on; `shrinkageWeight` below reports how much of
 * the posterior is still the prior talking.
 */

import { betaCredibleInterval, betaTailAbove, type CredibleInterval } from './beta';
import type { PatternInferencePolicy } from './policy';
import { assertPatternInferencePolicy } from './policy';

/**
 * The three outcomes of the sequential test, and the only three reachable.
 *
 * This is the point of using a sequential test rather than a threshold:
 * "keep watching" is a mathematical result with an error rate attached, not a
 * judgement call someone made up. It maps onto the existing
 * `PatternEpistemicState` -- it does not introduce a second verdict
 * vocabulary.
 */
export type SequentialVerdict = 'promote' | 'reject' | 'continue_observing';

export interface RecurrenceObservationCounts {
  /** Opportunities observed: occurrences + counterexamples. */
  readonly trials: number;
  /** Of those, the times the behaviour occurred. */
  readonly occurrences: number;
}

export interface RecurrenceAssessment {
  readonly trials: number;
  readonly occurrences: number;

  /** k/n with no prior. Null when nothing has been observed. */
  readonly observedRate: number | null;
  /** The gym prior's own rate, i.e. the shrinkage target. */
  readonly priorRate: number;
  /** Posterior mean of the recurrence rate. */
  readonly posteriorMean: number;
  readonly posteriorAlpha: number;
  readonly posteriorBeta: number;
  readonly credibleInterval: CredibleInterval;
  /**
   * Share of the posterior still contributed by the prior: (a0+b0)/(a0+b0+n).
   * 1 with no data, falling toward 0 as the athlete's own record accumulates.
   */
  readonly shrinkageWeight: number;
  /** Posterior mass above the policy's null rate. */
  readonly probabilityAboveNullRate: number;

  /** Log-likelihood ratio accumulated by the sequential test. */
  readonly logLikelihoodRatio: number;
  readonly upperBoundary: number;
  readonly lowerBoundary: number;
  readonly verdict: SequentialVerdict;
  /** True when the credible interval is wider than the policy allows. */
  readonly posteriorTooWide: boolean;
}

/**
 * Counts opportunities from a candidate's admitted observations.
 *
 * Deliberately takes counts rather than observations so the statistics stay
 * testable in isolation and the caller keeps control of what it admitted.
 */
export function assessRecurrence(
  counts: RecurrenceObservationCounts,
  policy: PatternInferencePolicy,
): RecurrenceAssessment {
  assertPatternInferencePolicy(policy);

  const { trials, occurrences } = counts;
  if (!Number.isInteger(trials) || trials < 0) {
    throw new TypeError('assessRecurrence requires a non-negative integer trial count.');
  }
  if (!Number.isInteger(occurrences) || occurrences < 0 || occurrences > trials) {
    throw new TypeError('assessRecurrence requires 0 <= occurrences <= trials.');
  }

  const { priorOccurrences, priorNonOccurrences } = policy.recurrencePrior;
  const priorMass = priorOccurrences + priorNonOccurrences;

  const posteriorAlpha = priorOccurrences + occurrences;
  const posteriorBeta = priorNonOccurrences + (trials - occurrences);
  const posteriorMean = posteriorAlpha / (posteriorAlpha + posteriorBeta);

  const credibleInterval = betaCredibleInterval(
    posteriorAlpha,
    posteriorBeta,
    policy.posteriorWidth.credibleMass,
  );

  const { nullRate, alternativeRate, falsePromotionRate, missedPatternRate } = policy.sequentialTest;

  // Wald's SPRT for a Bernoulli parameter. The log-likelihood ratio of the
  // observed sequence under H1 (rate = alternativeRate) against H0 (rate =
  // nullRate); order does not affect the sum, which is why a running total
  // over sessions and a batch recomputation agree.
  const logLikelihoodRatio = trials === 0
    ? 0
    : (occurrences * Math.log(alternativeRate / nullRate))
      + ((trials - occurrences) * Math.log((1 - alternativeRate) / (1 - nullRate)));

  const upperBoundary = Math.log((1 - missedPatternRate) / falsePromotionRate);
  const lowerBoundary = Math.log(missedPatternRate / (1 - falsePromotionRate));

  let verdict: SequentialVerdict;
  if (trials === 0) {
    verdict = 'continue_observing';
  } else if (logLikelihoodRatio >= upperBoundary) {
    verdict = 'promote';
  } else if (logLikelihoodRatio <= lowerBoundary) {
    verdict = 'reject';
  } else {
    verdict = 'continue_observing';
  }

  return Object.freeze({
    trials,
    occurrences,
    observedRate: trials === 0 ? null : occurrences / trials,
    priorRate: priorOccurrences / priorMass,
    posteriorMean,
    posteriorAlpha,
    posteriorBeta,
    credibleInterval,
    shrinkageWeight: priorMass / (priorMass + trials),
    probabilityAboveNullRate: betaTailAbove(posteriorAlpha, posteriorBeta, nullRate),
    logLikelihoodRatio,
    upperBoundary,
    lowerBoundary,
    verdict,
    posteriorTooWide: credibleInterval.width > policy.posteriorWidth.maximumCredibleWidth,
  });
}
