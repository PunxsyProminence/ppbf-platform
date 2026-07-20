import { normalizeJobPriority, normalizeJobTtlHours } from './shadowJobQueue';

describe('SHADOW job queue input hardening', () => {
  test.each([
    [undefined, 24],
    [0, 1],
    [-100, 1],
    [12.9, 12],
    [999, 168],
  ])('normalizes TTL %p to %p hours', (input, expected) => {
    expect(normalizeJobTtlHours(input)).toBe(expected);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite TTL %p',
    (input) => expect(() => normalizeJobTtlHours(input)).toThrow('finite number'),
  );

  test.each([
    [undefined, 3],
    [0, 1],
    [2.9, 2],
    [10, 5],
  ])('normalizes priority %p to %p', (input, expected) => {
    expect(normalizeJobPriority(input)).toBe(expected);
  });
});
