import { buildPersonalBaselineSnapshot } from './baseline';
import { calculatePersonalBaselineComparison, type DayWindowBaselinePolicy } from './engine';
import type { NumericObservation } from './types';

// Personal baseline over the athlete's own last 28 days (Jason 2026-10-17,
// OD-2026-10-17-020: from 7 check-ins, "provisional" until about 14, SD floor
// 0.5 point / 0.5 h relayed by Overwatch). Lane L50, PR-D1.

const DAY = 24 * 60 * 60 * 1_000;
const NOW = Date.parse('2026-10-17T12:00:00.000Z');

const POLICY: DayWindowBaselinePolicy = {
  metricKey: 'energy',
  windowDays: 28,
  minimumHistory: 7,
  adequateHistory: 14,
  sdFloor: 0.5,
};

function entry(id: string, daysAgo: number, value: number | null): NumericObservation<'numeric'> {
  return {
    observationId: id,
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    contextId: `check-in:${id}`,
    kind: 'numeric',
    value,
    unit: 'rating_1_5',
    dimensions: { metricKey: 'energy' },
    observedAt: new Date(NOW - daysAgo * DAY).toISOString(),
    source: { type: 'manual', quality: 'moderate', referenceId: `${id}-source` },
  };
}

function history(count: number, value: (index: number) => number, startDaysAgo = 1): NumericObservation<'numeric'>[] {
  return Array.from({ length: count }, (_, index) => entry(`h${index}`, startDaysAgo + (count - 1 - index), value(index)));
}

function run(past: NumericObservation<'numeric'>[], currentValue = 4, policy: DayWindowBaselinePolicy = POLICY) {
  const results = calculatePersonalBaselineComparison({
    current: entry('now', 0, currentValue),
    history: past,
    policy,
    policyVersion: 'check-in-baseline-2026-10-17',
  });
  return Object.fromEntries(results.map((result) => [result.outputKey, result]));
}

describe('personal baseline, day window', () => {
  test('six check-ins in the window is not enough: insufficient, no value', () => {
    const out = run(history(6, () => 3));
    expect(out.raw_change.value).toBeNull();
    expect(out.raw_change.validation.hardBlocks).toContain('INSUFFICIENT_HISTORY');
  });

  test('seven is enough, and reads provisional (SHORT_BASELINE) until fourteen', () => {
    const out = run(history(7, (index) => (index % 2 === 0 ? 3 : 4)));
    expect(out.raw_change.value).not.toBeNull();
    expect(out.raw_change.validation.warnings).toContain('SHORT_BASELINE');
    expect(run(history(14, (index) => (index % 2 === 0 ? 3 : 4))).raw_change.validation.warnings)
      .not.toContain('SHORT_BASELINE');
  });

  test('check-ins older than 28 days do not count', () => {
    // Ten from 30-39 days ago and three from this week: three in the window.
    const out = run([...history(10, () => 3, 30), ...history(3, () => 3, 1).map((item, index) => ({ ...item, observationId: `r${index}` }))]);
    expect(out.raw_change.validation.hardBlocks).toContain('INSUFFICIENT_HISTORY');
    expect(out.raw_change.inputObservationIds).toEqual(['r0', 'r1', 'r2', 'now']);
  });

  test('the SD floor: an athlete who always answered 3 gets (4 - 3) / 0.5, not a divide-by-zero', () => {
    const out = run(history(7, () => 3), 4);
    expect(out.raw_change.value).toBe(1);
    expect(out.standardized_change.value).toBe(2);
  });

  test('a real spread above the floor is used as it is', () => {
    // 1,5,1,5,1,5,1: sample SD well above 0.5.
    const out = run(history(7, (index) => (index % 2 === 0 ? 1 : 5)), 5);
    expect(out.standardized_change.value).toBeGreaterThan(0);
    expect(out.standardized_change.value).toBeLessThan(2);
  });

  test('the policy is recorded on the result, so the number is traceable to its rule', () => {
    expect(run(history(7, () => 3)).raw_change.parameters).toEqual({
      metricKey: 'energy',
      windowDays: 28,
      minimumHistory: 7,
      adequateHistory: 14,
      sdFloor: 0.5,
    });
  });

  test.each([
    ['a zero floor', { ...POLICY, sdFloor: 0 }],
    ['adequate below minimum', { ...POLICY, adequateHistory: 6 }],
    ['a fractional window', { ...POLICY, windowDays: 27.5 }],
  ])('refuses %s as INVALID_POLICY', (_label, policy) => {
    expect(run(history(7, () => 3), 4, policy as DayWindowBaselinePolicy).raw_change.validation.hardBlocks)
      .toContain('INVALID_POLICY');
  });
});

describe('day-window snapshots', () => {
  // An item's first check-in, and the first after 28+ days away, both select
  // no entries. Without the check-in anchor in the key they collided and the
  // save refused the second as a conflict (lane L50 review).
  test('two empty windows at different check-ins get different keys', () => {
    const snapshot = (effectiveAt: string) => buildPersonalBaselineSnapshot({
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      unit: 'hours',
      history: [],
      policy: { ...POLICY, metricKey: 'sleep_hours', policyVersion: 'check-in-baseline-2026-10-17' },
      effectiveAt,
    });
    const first = snapshot('2026-09-01T12:00:00.000Z');
    const later = snapshot('2026-10-11T12:00:00.000Z');
    expect(first.observationIds).toEqual([]);
    expect(later.observationIds).toEqual([]);
    expect(first.calculationKey).not.toBe(later.calculationKey);
    expect(first.windowSize).toBe(28);
  });
});
