/**
 * Single-case design acceptance.
 *
 * The exact test is checked against enumerations that can be done by hand:
 * with m=n=2 the Mann-Whitney null has six arrangements and the distribution
 * is (1,1,2,1,1), so every p-value below is a fraction with a denominator you
 * can count. Policy numbers are TEST values and carry no PPBF claim.
 */

import {
  assessSingleCaseDesign,
  exactMannWhitneyP,
  kendallTau,
  nonoverlapOfAllPairs,
  tauU,
  type SingleCaseDesignPolicy,
} from './singleCase';

const policy: SingleCaseDesignPolicy = {
  policyVersion: 'scd-policy-v0-test-not-ratified',
  ratifiedByAccountId: 'account-owner-1',
  ratifiedAt: '2026-01-01T00:00:00.000Z',
  minimumBaselineObservations: 4,
  minimumTreatmentObservations: 4,
  minimumNonoverlap: 0.7,
  maximumBaselineTrend: 0.5,
  significanceLevel: 0.05,
};

describe('kendallTau', () => {
  test('is zero for a flat series and for a symmetric one', () => {
    expect(kendallTau([0.5, 0.5, 0.5, 0.5])).toBe(0);
    expect(kendallTau([1, 2, 2, 1])).toBe(0);
  });

  test('is +1 for a strictly rising series and -1 for a falling one', () => {
    expect(kendallTau([1, 2, 3, 4])).toBe(1);
    expect(kendallTau([4, 3, 2, 1])).toBe(-1);
  });

  test('treats ties as stability rather than as missing evidence', () => {
    // Three of six pairs tied, three concordant.
    expect(kendallTau([1, 1, 2, 2])).toBeCloseTo(4 / 6, 12);
  });
});

describe('exactMannWhitneyP', () => {
  test('enumerates the m=n=2 null distribution correctly', () => {
    // Distribution over U = 0..4 is (1,1,2,1,1), total 6.
    expect(exactMannWhitneyP(2, 2, 4)).toBeCloseTo(1 / 6, 12);  // U >= 4
    expect(exactMannWhitneyP(2, 2, 3)).toBeCloseTo(2 / 6, 12);  // U >= 3
    expect(exactMannWhitneyP(2, 2, 2)).toBeCloseTo(4 / 6, 12);  // U >= 2
    expect(exactMannWhitneyP(2, 2, 0)).toBe(1);
  });

  test('the null distribution sums to the binomial coefficient', () => {
    // Total arrangements for m=3, n=3 is C(6,3) = 20; perfect separation is
    // one of them.
    expect(exactMannWhitneyP(3, 3, 9)).toBeCloseTo(1 / 20, 12);
    // m=4, n=4: C(8,4) = 70.
    expect(exactMannWhitneyP(4, 4, 16)).toBeCloseTo(1 / 70, 12);
    // m=5, n=5: C(10,5) = 252.
    expect(exactMannWhitneyP(5, 5, 25)).toBeCloseTo(1 / 252, 12);
  });

  test('is monotone: a stronger result is never less significant', () => {
    let previous = 0;
    for (let u = 16; u >= 0; u -= 1) {
      const p = exactMannWhitneyP(4, 4, u);
      expect(p).toBeGreaterThanOrEqual(previous);
      previous = p;
    }
  });

  test('rounds ties toward finding no effect', () => {
    // 3.5 improved pairs is treated as 3, widening the tail.
    expect(exactMannWhitneyP(2, 2, 3.5)).toBe(exactMannWhitneyP(2, 2, 3));
  });

  test('an empty phase yields no significance', () => {
    expect(exactMannWhitneyP(0, 4, 0)).toBe(1);
  });
});

describe('nonoverlapOfAllPairs', () => {
  test('perfect separation in the improving direction is 1', () => {
    expect(nonoverlapOfAllPairs([1, 1, 1], [0, 0, 0], 'decrease').nap).toBe(1);
    expect(nonoverlapOfAllPairs([0, 0, 0], [1, 1, 1], 'increase').nap).toBe(1);
  });

  test('perfect separation the wrong way is 0', () => {
    expect(nonoverlapOfAllPairs([0, 0, 0], [1, 1, 1], 'decrease').nap).toBe(0);
  });

  test('identical phases sit at chance', () => {
    expect(nonoverlapOfAllPairs([1, 1], [1, 1], 'decrease').nap).toBe(0.5);
  });
});

describe('tauU baseline correction', () => {
  test('credits an intervention when the baseline was flat', () => {
    const flat = tauU([1, 1, 1, 1], [0, 0, 0, 0], 'decrease');
    expect(flat).toBeGreaterThan(0.5);
  });

  test('does NOT credit an intervention for a decline already underway', () => {
    // The athlete was improving before anyone intervened. Raw nonoverlap looks
    // identical to the flat-baseline case; Tau-U does not.
    const alreadyFalling = tauU([4, 3, 2, 1], [0, 0, 0, 0], 'decrease');
    const flat = tauU([1, 1, 1, 1], [0, 0, 0, 0], 'decrease');

    expect(nonoverlapOfAllPairs([4, 3, 2, 1], [0, 0, 0, 0], 'decrease').nap).toBe(1);
    expect(nonoverlapOfAllPairs([1, 1, 1, 1], [0, 0, 0, 0], 'decrease').nap).toBe(1);
    // Same NAP, materially different Tau-U. This is the whole point.
    expect(alreadyFalling).toBeLessThan(flat);
  });
});

describe('assessSingleCaseDesign', () => {
  test('a short phase is insufficient, not negative', () => {
    const result = assessSingleCaseDesign(
      { baseline: [1, 1], treatment: [0, 0], direction: 'decrease' },
      policy,
    );
    expect(result.verdict).toBe('insufficient_evidence');
    expect(result.reasons).toContain('SCD_PHASE_TOO_SHORT');
  });

  test('a trending baseline refuses the comparison outright', () => {
    // The athlete was already improving; nothing after can be separated from
    // what was happening before.
    const result = assessSingleCaseDesign(
      { baseline: [1, 0.8, 0.6, 0.4, 0.2], treatment: [0, 0, 0, 0, 0], direction: 'decrease' },
      policy,
    );
    expect(result.baselineStable).toBe(false);
    expect(result.verdict).toBe('baseline_unstable');
    expect(result.reasons).toContain('SCD_BASELINE_UNSTABLE');
  });

  test('a clean effect against a flat baseline is supported', () => {
    const result = assessSingleCaseDesign(
      { baseline: [1, 1, 1, 1, 1], treatment: [0, 0, 0, 0, 0], direction: 'decrease' },
      policy,
    );
    expect(result.baselineStable).toBe(true);
    expect(result.nonoverlap.nap).toBe(1);
    expect(result.exactP).toBeCloseTo(1 / 252, 12);
    expect(result.verdict).toBe('effect_supported');
    expect(result.reasons).toEqual([]);
  });

  test('a real but small change is not called an effect', () => {
    const result = assessSingleCaseDesign(
      { baseline: [1, 0.8, 1, 0.8], treatment: [0.8, 1, 0.6, 0.8], direction: 'decrease' },
      policy,
    );
    expect(result.verdict).toBe('no_effect_detected');
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  test('direction is required, never inferred', () => {
    expect(() => assessSingleCaseDesign(
      { baseline: [1, 1, 1, 1], treatment: [0, 0, 0, 0], direction: 'better' as never },
      policy,
    )).toThrow(/not inferable from the data/);
  });

  test('a change in the wrong direction is never an effect', () => {
    const result = assessSingleCaseDesign(
      { baseline: [0, 0, 0, 0, 0], treatment: [1, 1, 1, 1, 1], direction: 'decrease' },
      policy,
    );
    expect(result.nonoverlap.nap).toBe(0);
    expect(result.verdict).toBe('no_effect_detected');
  });

  test('refuses without a ratified policy', () => {
    expect(() => assessSingleCaseDesign(
      { baseline: [1, 1, 1, 1], treatment: [0, 0, 0, 0], direction: 'decrease' },
      undefined as unknown as SingleCaseDesignPolicy,
    )).toThrow(/SCD_POLICY_MISSING/);
  });

  test('refuses a baseline too short to be checked for stability', () => {
    expect(() => assessSingleCaseDesign(
      { baseline: [1, 1, 1, 1], treatment: [0, 0, 0, 0], direction: 'decrease' },
      { ...policy, minimumBaselineObservations: 2 },
    )).toThrow(/two points cannot show whether a baseline is stable/);
  });

  test('rejects non-finite series values rather than treating absence as data', () => {
    expect(() => assessSingleCaseDesign(
      { baseline: [1, Number.NaN, 1, 1], treatment: [0, 0, 0, 0], direction: 'decrease' },
      policy,
    )).toThrow(/absence is not a value/);
  });

  test('ships no default policy', async () => {
    const scdModule = await import('./singleCase');
    expect(Object.keys(scdModule).some((name) => /DEFAULT|STANDARD|RECOMMENDED/i.test(name)))
      .toBe(false);
  });

  test('is deterministic', () => {
    const input = { baseline: [1, 1, 0.8, 1, 1], treatment: [0, 0.2, 0, 0, 0], direction: 'decrease' as const };
    expect(assessSingleCaseDesign(input, policy)).toEqual(assessSingleCaseDesign(input, policy));
  });
});
