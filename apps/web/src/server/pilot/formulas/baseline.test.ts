import { buildPersonalBaselineSnapshot, type BaselinePolicy } from './baseline';
import type { NumericObservation } from './types';

const policy: BaselinePolicy = {
  metricKey: 'jab_count',
  windowSize: 8,
  minimumHistory: 4,
  adequateHistory: 8,
  policyVersion: 'baseline-policy-v1',
};

function metricObservation(
  index: number,
  overrides: Partial<NumericObservation<'numeric', 'count'>> = {},
): NumericObservation<'numeric', 'count'> {
  return {
    observationId: `metric-${index}`,
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    contextId: `session-${index}`,
    kind: 'numeric',
    value: index,
    unit: 'count',
    dimensions: { metricKey: 'jab_count' },
    observedAt: `2026-07-${String(index).padStart(2, '0')}T10:00:00.000Z`,
    source: {
      type: 'system_timer',
      quality: 'verified',
      referenceId: `source-${index}`,
    },
    ...overrides,
  };
}

describe('personal formula baselines', () => {
  test.each([
    { count: 0, status: 'insufficient_history', mean: null, sd: null },
    { count: 3, status: 'insufficient_history', mean: null, sd: null },
    { count: 4, status: 'building', mean: 2.5, sd: 1.2909944487358056 },
    { count: 8, status: 'adequate', mean: 4.5, sd: 2.449489742783178 },
  ] as const)('uses explicit 4/8 history states for $count observations', ({
    count,
    status,
    mean,
    sd,
  }) => {
    const snapshot = buildPersonalBaselineSnapshot({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      unit: 'count',
      history: Array.from({ length: count }, (_, index) => metricObservation(index + 1)),
      policy,
      effectiveAt: '2026-07-20T10:00:00.000Z',
    });

    expect(snapshot.historyStatus).toBe(status);
    if (mean == null) {
      expect(snapshot.baselineMean).toBeNull();
      expect(snapshot.baselineSampleSd).toBeNull();
    } else {
      expect(snapshot.baselineMean).toBeCloseTo(mean, 10);
      expect(snapshot.baselineSampleSd).toBeCloseTo(sd!, 10);
    }
    expect(snapshot.metricKey).toBe('jab_count');
    expect(snapshot.unit).toBe('count');
    expect(snapshot.policyVersion).toBe('baseline-policy-v1');
    expect(snapshot.parameters).toEqual({
      metricKey: 'jab_count',
      windowSize: 8,
      minimumHistory: 4,
      adequateHistory: 8,
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test('sorts history before selecting the immutable deterministic window', () => {
    const history = Array.from({ length: 10 }, (_, index) => metricObservation(index + 1));
    const forward = buildPersonalBaselineSnapshot({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      unit: 'count',
      history,
      policy,
    });
    const reverse = buildPersonalBaselineSnapshot({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      unit: 'count',
      history: [...history].reverse(),
      policy,
    });

    expect(forward.calculationKey).toBe(reverse.calculationKey);
    expect(forward.observationIds).toEqual([
      'metric-3',
      'metric-4',
      'metric-5',
      'metric-6',
      'metric-7',
      'metric-8',
      'metric-9',
      'metric-10',
    ]);
    expect(forward.baselineMean).toBe(6.5);
  });

  test('changes identity when metric policy changes and rejects cross-tenant history', () => {
    const history = Array.from({ length: 4 }, (_, index) => metricObservation(index + 1));
    const first = buildPersonalBaselineSnapshot({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      unit: 'count',
      history,
      policy,
    });
    const versioned = buildPersonalBaselineSnapshot({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      unit: 'count',
      history,
      policy: { ...policy, policyVersion: 'baseline-policy-v2' },
    });
    expect(first.calculationKey).not.toBe(versioned.calculationKey);

    expect(() => buildPersonalBaselineSnapshot({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      unit: 'count',
      history: [
        metricObservation(1),
        metricObservation(2),
        metricObservation(3),
        metricObservation(4, { organizationId: 'org-2' }),
      ],
      policy,
    })).toThrow('out-of-scope');
  });
});
