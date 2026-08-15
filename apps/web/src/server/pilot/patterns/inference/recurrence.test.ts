/**
 * Stack §2.2/§2.3 acceptance. The policy below is a TEST policy: its numbers
 * exist so the properties have something to be judged against and carry no
 * PPBF claim.
 */

import { assessRecurrence } from './recurrence';
import type { PatternInferencePolicy } from './policy';

const policy: PatternInferencePolicy = {
  policyVersion: 'inference-policy-v0-test-not-ratified',
  ratifiedByAccountId: 'account-owner-1',
  ratifiedAt: '2026-01-01T00:00:00.000Z',
  // Gym prior: the behaviour shows up about a quarter of the time.
  recurrencePrior: { priorOccurrences: 1, priorNonOccurrences: 3 },
  sequentialTest: {
    nullRate: 0.2,
    alternativeRate: 0.6,
    falsePromotionRate: 0.05,
    missedPatternRate: 0.2,
  },
  posteriorWidth: { credibleMass: 0.9, maximumCredibleWidth: 0.4 },
  stratifiedAttribution: { concentration: 1, minimumStratumSize: 2 },
  drift: { ewmaLambda: 0.3, cusumSlack: 0.25, cusumThreshold: 1.5, minimumHistorySessions: 3 },
};

describe('conjugate recurrence (§2.2)', () => {
  test('with no observations the posterior is exactly the prior', () => {
    const result = assessRecurrence({ trials: 0, occurrences: 0 }, policy);
    expect(result.observedRate).toBeNull();
    expect(result.posteriorMean).toBeCloseTo(0.25, 12);
    expect(result.shrinkageWeight).toBe(1);
    expect(result.verdict).toBe('continue_observing');
  });

  test('shrinks a thin record toward the gym prior', () => {
    // Two for two looks like a rate of 1.0. The posterior does not say that.
    const result = assessRecurrence({ trials: 2, occurrences: 2 }, policy);
    expect(result.observedRate).toBe(1);
    expect(result.posteriorMean).toBeCloseTo(3 / 6, 12);
    expect(result.posteriorMean).toBeLessThan(result.observedRate!);
    expect(result.posteriorMean).toBeGreaterThan(result.priorRate);
  });

  test('un-shrinks toward the athlete as their own record accumulates', () => {
    const thin = assessRecurrence({ trials: 4, occurrences: 3 }, policy);
    const thick = assessRecurrence({ trials: 40, occurrences: 30 }, policy);
    const thickest = assessRecurrence({ trials: 400, occurrences: 300 }, policy);

    // Same observed rate (0.75) at three volumes: the posterior must march
    // away from the prior and toward the observation.
    expect(thin.observedRate).toBeCloseTo(0.75, 12);
    expect(thick.observedRate).toBeCloseTo(0.75, 12);

    expect(thin.shrinkageWeight).toBeGreaterThan(thick.shrinkageWeight);
    expect(thick.shrinkageWeight).toBeGreaterThan(thickest.shrinkageWeight);

    const distanceFromObserved = (r: { posteriorMean: number }) => Math.abs(r.posteriorMean - 0.75);
    expect(distanceFromObserved(thin)).toBeGreaterThan(distanceFromObserved(thick));
    expect(distanceFromObserved(thick)).toBeGreaterThan(distanceFromObserved(thickest));
  });

  test('a wide posterior is reported as wide, not as a confident mean', () => {
    // The §6 acceptance case: thin evidence -> insufficient.
    const thin = assessRecurrence({ trials: 4, occurrences: 2 }, policy);
    expect(thin.posteriorTooWide).toBe(true);
    expect(thin.credibleInterval.width).toBeGreaterThan(policy.posteriorWidth.maximumCredibleWidth);

    const thick = assessRecurrence({ trials: 50, occurrences: 40 }, policy);
    expect(thick.posteriorTooWide).toBe(false);
  });

  test('the interval narrows monotonically as evidence accumulates', () => {
    const widths = [4, 10, 30, 100].map(
      (n) => assessRecurrence({ trials: n, occurrences: Math.round(n * 0.8) }, policy)
        .credibleInterval.width,
    );
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeLessThan(widths[i - 1]);
    }
  });
});

describe('sequential promotion (§2.3)', () => {
  test('all three outcomes are reachable', () => {
    // Strongly recurring -> promote.
    expect(assessRecurrence({ trials: 10, occurrences: 8 }, policy).verdict).toBe('promote');
    // Never recurs -> reject. A real result, not a failure to compute.
    expect(assessRecurrence({ trials: 10, occurrences: 0 }, policy).verdict).toBe('reject');
    // Genuinely ambiguous -> keep watching.
    expect(assessRecurrence({ trials: 4, occurrences: 2 }, policy).verdict).toBe('continue_observing');
  });

  test('the boundaries are Wald\'s, computed from the policy error rates', () => {
    const result = assessRecurrence({ trials: 4, occurrences: 2 }, policy);
    expect(result.upperBoundary).toBeCloseTo(Math.log(0.8 / 0.05), 12);
    expect(result.lowerBoundary).toBeCloseTo(Math.log(0.2 / 0.95), 12);
    expect(result.logLikelihoodRatio)
      .toBeCloseTo((2 * Math.log(0.6 / 0.2)) + (2 * Math.log(0.4 / 0.8)), 12);
  });

  test('the log-likelihood ratio does not depend on the order of trials', () => {
    // Same k and n reached by any path gives the same statistic, which is why
    // a batch recomputation agrees with a running total.
    const a = assessRecurrence({ trials: 12, occurrences: 7 }, policy);
    const b = assessRecurrence({ trials: 12, occurrences: 7 }, policy);
    expect(a.logLikelihoodRatio).toBe(b.logLikelihoodRatio);
  });

  test('a tightening error budget makes promotion harder, never easier', () => {
    const lenient = assessRecurrence({ trials: 6, occurrences: 5 }, policy);
    const strict = assessRecurrence({ trials: 6, occurrences: 5 }, {
      ...policy,
      sequentialTest: { ...policy.sequentialTest, falsePromotionRate: 0.001 },
    });
    expect(strict.upperBoundary).toBeGreaterThan(lenient.upperBoundary);
    expect(strict.logLikelihoodRatio).toBe(lenient.logLikelihoodRatio);
  });
});

describe('inference policy refusal', () => {
  test('refuses when no policy is supplied', () => {
    expect(() => assessRecurrence(
      { trials: 4, occurrences: 2 },
      undefined as unknown as PatternInferencePolicy,
    )).toThrow(/INFERENCE_POLICY_MISSING/);
  });

  test('refuses a bar nobody ratified', () => {
    expect(() => assessRecurrence({ trials: 4, occurrences: 2 }, {
      ...policy,
      ratifiedByAccountId: '   ',
    })).toThrow(/attributable to a person/);
  });

  test('refuses a test with nothing to discriminate', () => {
    expect(() => assessRecurrence({ trials: 4, occurrences: 2 }, {
      ...policy,
      sequentialTest: { ...policy.sequentialTest, alternativeRate: 0.2 },
    })).toThrow(/must exceed nullRate/);
  });

  test('rejects impossible counts rather than coercing them', () => {
    expect(() => assessRecurrence({ trials: 2, occurrences: 5 }, policy))
      .toThrow(/0 <= occurrences <= trials/);
    expect(() => assessRecurrence({ trials: 2.5, occurrences: 1 }, policy))
      .toThrow(/non-negative integer/);
  });

  test('ships no default policy', async () => {
    const module = await import('./policy');
    expect(Object.keys(module).some((name) => /DEFAULT|STANDARD|RECOMMENDED/i.test(name))).toBe(false);
  });
});
