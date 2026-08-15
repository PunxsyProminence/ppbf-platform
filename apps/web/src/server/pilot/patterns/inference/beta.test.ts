/**
 * The numerics are checked against values that can be derived by hand, not
 * against a reference implementation's output. For integer shape parameters
 * the regularized incomplete beta is a finite binomial sum, so every expected
 * value below is exact arithmetic rather than a recorded observation.
 */

import {
  betaCredibleInterval,
  betaQuantile,
  betaTailAbove,
  logBeta,
  logGamma,
  regularizedIncompleteBeta,
} from './beta';

describe('logGamma', () => {
  test.each([
    { input: 1, expected: 0 },                       // gamma(1) = 1
    { input: 2, expected: 0 },                       // gamma(2) = 1
    { input: 5, expected: Math.log(24) },            // gamma(5) = 4! = 24
    { input: 6, expected: Math.log(120) },           // gamma(6) = 5! = 120
    { input: 0.5, expected: Math.log(Math.sqrt(Math.PI)) }, // gamma(1/2) = sqrt(pi)
  ])('logGamma($input)', ({ input, expected }) => {
    expect(logGamma(input)).toBeCloseTo(expected, 10);
  });

  test('rejects non-positive arguments rather than returning NaN', () => {
    expect(() => logGamma(0)).toThrow(/positive finite/);
    expect(() => logGamma(-1)).toThrow(/positive finite/);
    expect(() => logGamma(Number.NaN)).toThrow(/positive finite/);
  });
});

describe('logBeta', () => {
  test('B(1,1) = 1', () => {
    expect(logBeta(1, 1)).toBeCloseTo(0, 12);
  });

  test('B(2,3) = 1/12', () => {
    expect(logBeta(2, 3)).toBeCloseTo(Math.log(1 / 12), 12);
  });
});

describe('regularizedIncompleteBeta', () => {
  test('Beta(1,1) is uniform, so I_x(1,1) = x', () => {
    for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(regularizedIncompleteBeta(1, 1, x)).toBeCloseTo(x, 10);
    }
  });

  test('matches the exact binomial sum for integer shapes', () => {
    // I_x(a,b) = sum_{j=a}^{n} C(n,j) x^j (1-x)^(n-j), n = a+b-1.
    // a=2, b=3, x=1/2: (6 + 4 + 1)/16 = 11/16.
    expect(regularizedIncompleteBeta(2, 3, 0.5)).toBeCloseTo(11 / 16, 10);
    // a=3, b=2, x=1/2: (4 + 1)/16 = 5/16.
    expect(regularizedIncompleteBeta(3, 2, 0.5)).toBeCloseTo(5 / 16, 10);
  });

  test('is symmetric: I_x(a,b) = 1 - I_(1-x)(b,a)', () => {
    for (const [a, b, x] of [[2, 5, 0.3], [7, 3, 0.8], [1.5, 4.5, 0.42]] as const) {
      expect(regularizedIncompleteBeta(a, b, x))
        .toBeCloseTo(1 - regularizedIncompleteBeta(b, a, 1 - x), 10);
    }
  });

  test('is monotone increasing in x', () => {
    let previous = -1;
    for (let x = 0; x <= 1.0001; x += 0.05) {
      const value = regularizedIncompleteBeta(3, 4, Math.min(x, 1));
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });

  test('pins the endpoints exactly', () => {
    expect(regularizedIncompleteBeta(2, 3, 0)).toBe(0);
    expect(regularizedIncompleteBeta(2, 3, 1)).toBe(1);
  });

  test('rejects invalid shapes and out-of-range x', () => {
    expect(() => regularizedIncompleteBeta(0, 1, 0.5)).toThrow(/positive finite/);
    expect(() => regularizedIncompleteBeta(1, -2, 0.5)).toThrow(/positive finite/);
    expect(() => regularizedIncompleteBeta(1, 1, 1.5)).toThrow(/x in \[0, 1\]/);
  });
});

describe('betaQuantile', () => {
  test('inverts the uniform case exactly', () => {
    for (const p of [0.05, 0.5, 0.95]) {
      expect(betaQuantile(1, 1, p)).toBeCloseTo(p, 8);
    }
  });

  test('symmetric Beta(a,a) has median 1/2', () => {
    expect(betaQuantile(2, 2, 0.5)).toBeCloseTo(0.5, 8);
    expect(betaQuantile(9, 9, 0.5)).toBeCloseTo(0.5, 8);
  });

  test('round-trips against the CDF', () => {
    for (const [a, b, p] of [[2, 5, 0.3], [7, 3, 0.9], [4, 4, 0.025]] as const) {
      const x = betaQuantile(a, b, p);
      expect(regularizedIncompleteBeta(a, b, x)).toBeCloseTo(p, 8);
    }
  });
});

describe('betaCredibleInterval', () => {
  test('narrows as evidence accumulates at a fixed rate', () => {
    // Same underlying rate (1/2), more observations: the interval must shrink.
    const thin = betaCredibleInterval(2, 2, 0.9);
    const thicker = betaCredibleInterval(11, 11, 0.9);
    const thickest = betaCredibleInterval(51, 51, 0.9);

    expect(thin.width).toBeGreaterThan(thicker.width);
    expect(thicker.width).toBeGreaterThan(thickest.width);
    // The property the promotion gate depends on: two observations leave a
    // posterior far too wide to claim anything.
    expect(thin.width).toBeGreaterThan(0.5);
  });

  test('is equal-tailed and brackets the mean', () => {
    const interval = betaCredibleInterval(3, 7, 0.95);
    expect(regularizedIncompleteBeta(3, 7, interval.lower)).toBeCloseTo(0.025, 6);
    expect(regularizedIncompleteBeta(3, 7, interval.upper)).toBeCloseTo(0.975, 6);
    expect(interval.lower).toBeLessThan(3 / 10);
    expect(interval.upper).toBeGreaterThan(3 / 10);
    expect(interval.mass).toBe(0.95);
    expect(Object.isFrozen(interval)).toBe(true);
  });

  test('rejects a degenerate mass instead of clamping it', () => {
    expect(() => betaCredibleInterval(2, 2, 0)).toThrow(/strictly between/);
    expect(() => betaCredibleInterval(2, 2, 1)).toThrow(/strictly between/);
  });
});

describe('betaTailAbove', () => {
  test('is the complement of the CDF', () => {
    expect(betaTailAbove(2, 3, 0.5)).toBeCloseTo(1 - (11 / 16), 10);
  });

  test('rises as the observed rate rises', () => {
    // 8 of 10 vs 2 of 10, same prior: the former has far more mass above 0.5.
    expect(betaTailAbove(9, 3, 0.5)).toBeGreaterThan(betaTailAbove(3, 9, 0.5));
  });
});
