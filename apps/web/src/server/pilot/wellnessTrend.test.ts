// The pure half of the wellness read behind Rule 7 ("Load up, wellness
// down"). What these pin: each item is read on its own, "worse" follows the
// item's recorded direction (energy down, soreness up), thin data stays
// silent, and the threshold is a full point.

import { WELLNESS_SCALES } from '../../shared/wellnessScales';
import {
  readWellnessDeclines,
  WELLNESS_MIN_CHECKINS,
  WELLNESS_PRIOR_DAYS,
  WELLNESS_RECENT_DAYS,
  WELLNESS_SHIFT_POINTS,
  WELLNESS_TREND_ITEMS,
  type WellnessWindowRow,
} from './wellnessTrend';
import { LOAD_JUMP_PRIOR_WEEKS } from './weeklySessionLoad';

function windowRow(overrides: Partial<WellnessWindowRow> = {}): WellnessWindowRow {
  return {
    athlete_id: 'ath-1',
    energy_recent_avg: 4,
    energy_recent_count: 3,
    energy_prior_avg: 4,
    energy_prior_count: 10,
    soreness_recent_avg: 2,
    soreness_recent_count: 3,
    soreness_prior_avg: 2,
    soreness_prior_count: 10,
    ...overrides,
  };
}

test('the window is the load read\'s window: 7 days against the 28 before', () => {
  expect(WELLNESS_RECENT_DAYS).toBe(7);
  expect(WELLNESS_PRIOR_DAYS).toBe(LOAD_JUMP_PRIOR_WEEKS * 7);
  expect(WELLNESS_PRIOR_DAYS).toBe(28);
  expect(WELLNESS_MIN_CHECKINS).toBe(2);
  expect(WELLNESS_SHIFT_POINTS).toBe(1);
});

test('the items are energy and soreness, and their directions come from the shared scales', () => {
  expect([...WELLNESS_TREND_ITEMS]).toEqual(['energy', 'soreness']);
  const direction = Object.fromEntries(WELLNESS_SCALES.map((scale) => [scale.key, scale.direction]));
  expect(direction.energy).toBe('higher_is_better');
  expect(direction.soreness).toBe('higher_is_worse');
});

test('no change, no decline', () => {
  expect(readWellnessDeclines([windowRow()])).toEqual([]);
});

test('energy falling a full point is a decline', () => {
  expect(readWellnessDeclines([windowRow({ energy_recent_avg: 3 })])).toEqual([
    {
      athlete_id: 'ath-1',
      item: 'energy',
      direction: 'higher_is_better',
      recent_avg: 3,
      prior_avg: 4,
      recent_count: 3,
      prior_count: 10,
    },
  ]);
});

test('soreness RISING a full point is a decline; soreness falling is not', () => {
  const rising = readWellnessDeclines([windowRow({ soreness_recent_avg: 3 })]);
  expect(rising.map((d) => [d.item, d.direction])).toEqual([['soreness', 'higher_is_worse']]);
  expect(readWellnessDeclines([windowRow({ soreness_recent_avg: 1 })])).toEqual([]);
});

test('energy rising is not a decline', () => {
  expect(readWellnessDeclines([windowRow({ energy_recent_avg: 5 })])).toEqual([]);
});

test('just under a point stays silent; thirds that equal a point in arithmetic still count', () => {
  expect(readWellnessDeclines([windowRow({ energy_recent_avg: 3.01 })])).toEqual([]);
  const thirds = readWellnessDeclines([windowRow({ energy_prior_avg: 13 / 3, energy_recent_avg: 10 / 3 })]);
  expect(thirds).toHaveLength(1);
});

test('fewer than two answers on either side stays silent', () => {
  expect(readWellnessDeclines([windowRow({ energy_recent_avg: 1, energy_recent_count: 1 })])).toEqual([]);
  expect(readWellnessDeclines([windowRow({ energy_recent_avg: 1, energy_prior_count: 1 })])).toEqual([]);
});

test('an item nobody answered (null average) is unknown, not a decline', () => {
  expect(
    readWellnessDeclines([windowRow({ energy_recent_avg: null, energy_recent_count: 0, soreness_prior_avg: null })]),
  ).toEqual([]);
});

test('items are never blended: one bad item and one good item still yield exactly the bad one', () => {
  const declines = readWellnessDeclines([windowRow({ energy_recent_avg: 2.5, soreness_recent_avg: 1 })]);
  expect(declines.map((d) => d.item)).toEqual(['energy']);
});

test('pg numeric strings are read as numbers', () => {
  const row = windowRow({
    energy_recent_avg: '3' as unknown as number,
    energy_recent_count: '2' as unknown as number,
  });
  expect(readWellnessDeclines([row])).toHaveLength(1);
});
