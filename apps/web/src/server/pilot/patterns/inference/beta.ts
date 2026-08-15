/**
 * Beta distribution numerics: log-gamma, the regularized incomplete beta
 * function, and its inverse.
 *
 * WHY THIS FILE EXISTS AT ALL. The conjugate recurrence model in
 * `recurrence.ts` needs two things a Beta posterior can give and a point
 * estimate cannot: how wide the credible interval is (so a thin-evidence
 * posterior can be reported as *wide* rather than as a confident-looking
 * mean), and the tail mass above a rate of interest. Both are values of
 * I_x(a,b). One function serves both, so this is the whole numerical surface
 * Phase A adds.
 *
 * NO DEPENDENCIES. These are textbook algorithms implemented directly rather
 * than pulled from a stats package: Phase A is closed-form-only by contract,
 * and a runtime math dependency would fail the review bar.
 *
 * EVERY NUMBER IN THIS FILE IS A MATHEMATICAL CONSTANT -- Lanczos
 * coefficients, convergence tolerances, iteration caps. None is a policy
 * value, none encodes a coaching judgement, and none is tunable by a caller.
 * Policy numbers live in `policy.ts` and are injected.
 */

// Lanczos approximation coefficients (g = 7, n = 9). Standard published
// values; reproduce lgamma to ~15 significant digits.
const LANCZOS_G = 7;
const LANCZOS_COEFFICIENTS: readonly number[] = [
  0.99999999999980993,
  676.5203681218851,
  -1259.1392167224028,
  771.32342877765313,
  -176.61502916214059,
  12.507343278686905,
  -0.13857109526572012,
  9.9843695780195716e-6,
  1.5056327351493116e-7,
];

const CONTINUED_FRACTION_MAX_ITERATIONS = 300;
const CONTINUED_FRACTION_EPSILON = 3e-16;
const TINY = 1e-300;
const BISECTION_MAX_ITERATIONS = 200;
const BISECTION_TOLERANCE = 1e-12;

/** Natural log of the gamma function, for real arguments > 0. */
export function logGamma(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError('logGamma requires a positive finite argument.');
  }
  // Reflection is unnecessary: every caller here passes positive shape
  // parameters, and rejecting the rest keeps the branch count honest.
  const x = value - 1;
  let series = LANCZOS_COEFFICIENTS[0];
  for (let index = 1; index < LANCZOS_COEFFICIENTS.length; index += 1) {
    series += LANCZOS_COEFFICIENTS[index] / (x + index);
  }
  const t = x + LANCZOS_G + 0.5;
  return (0.5 * Math.log(2 * Math.PI)) + ((x + 0.5) * Math.log(t)) - t + Math.log(series);
}

/** Log of the Beta function, B(a,b). */
export function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/**
 * Continued-fraction expansion used by `regularizedIncompleteBeta`, evaluated
 * with the modified Lentz algorithm.
 */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - ((qab * x) / qap);
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let result = d;

  for (let m = 1; m <= CONTINUED_FRACTION_MAX_ITERATIONS; m += 1) {
    const m2 = 2 * m;

    // Even step.
    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + (numerator * d);
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + (numerator / c);
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    result *= d * c;

    // Odd step.
    numerator = -((a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + (numerator * d);
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + (numerator / c);
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    result *= delta;

    if (Math.abs(delta - 1) < CONTINUED_FRACTION_EPSILON) {
      return result;
    }
  }

  // Non-convergence is a bug in the caller's arguments, not an abstention:
  // every shape this module produces is well inside the convergent region.
  throw new RangeError('Incomplete beta continued fraction failed to converge.');
}

/**
 * I_x(a,b) -- the regularized incomplete beta function, i.e. the CDF of
 * Beta(a,b) evaluated at x.
 */
export function regularizedIncompleteBeta(a: number, b: number, x: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    throw new RangeError('regularizedIncompleteBeta requires positive finite shape parameters.');
  }
  if (!Number.isFinite(x) || x < 0 || x > 1) {
    throw new RangeError('regularizedIncompleteBeta requires x in [0, 1].');
  }
  if (x === 0) return 0;
  if (x === 1) return 1;

  const front = Math.exp(
    (a * Math.log(x)) + (b * Math.log1p(-x)) - logBeta(a, b),
  );

  // The expansion converges quickly only on one side of this point; the
  // symmetry I_x(a,b) = 1 - I_{1-x}(b,a) covers the other.
  if (x < (a + 1) / (a + b + 2)) {
    return (front * betaContinuedFraction(a, b, x)) / a;
  }
  return 1 - ((Math.exp(
    (b * Math.log1p(-x)) + (a * Math.log(x)) - logBeta(b, a),
  ) * betaContinuedFraction(b, a, 1 - x)) / b);
}

/**
 * Inverse CDF (quantile) of Beta(a,b), by bisection on the CDF.
 *
 * Bisection rather than Newton: the CDF is monotone on [0,1], so bisection
 * cannot diverge, and at the small shape parameters this module actually sees
 * (a handful of observations) robustness matters more than iteration count.
 */
export function betaQuantile(a: number, b: number, probability: number): number {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new RangeError('betaQuantile requires a probability in [0, 1].');
  }
  if (probability === 0) return 0;
  if (probability === 1) return 1;

  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < BISECTION_MAX_ITERATIONS; iteration += 1) {
    const middle = (low + high) / 2;
    if (regularizedIncompleteBeta(a, b, middle) < probability) {
      low = middle;
    } else {
      high = middle;
    }
    if (high - low < BISECTION_TOLERANCE) break;
  }
  return (low + high) / 2;
}

export interface CredibleInterval {
  readonly lower: number;
  readonly upper: number;
  readonly width: number;
  /** The mass the interval covers, echoed back so a result is self-describing. */
  readonly mass: number;
}

/**
 * Equal-tailed credible interval for Beta(a,b).
 *
 * Equal-tailed rather than highest-density: it is monotone in the requested
 * mass, reproducible to the digit, and does not require an optimizer. For a
 * posterior whose only job is to say "still wide" or "now narrow", the extra
 * machinery of an HDI would buy nothing a reviewer could check by hand.
 */
export function betaCredibleInterval(a: number, b: number, mass: number): CredibleInterval {
  if (!Number.isFinite(mass) || mass <= 0 || mass >= 1) {
    throw new RangeError('betaCredibleInterval requires mass strictly between 0 and 1.');
  }
  const tail = (1 - mass) / 2;
  const lower = betaQuantile(a, b, tail);
  const upper = betaQuantile(a, b, 1 - tail);
  return Object.freeze({ lower, upper, width: upper - lower, mass });
}

/** P(rate > threshold) under Beta(a,b). */
export function betaTailAbove(a: number, b: number, threshold: number): number {
  return 1 - regularizedIncompleteBeta(a, b, threshold);
}
