import { DEFAULT_WINDOW_DAYS, MAX_WINDOW_DAYS, resolveExposureWindow } from './athleteDrillExposure';

describe('resolveExposureWindow', () => {
  // 2026-10-04 02:00 UTC is still 2026-10-03 in the gym (America/New_York).
  const now = new Date('2026-10-04T02:00:00Z');

  test('defaults to the last DEFAULT_WINDOW_DAYS gym-local days, both ends inclusive', () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(28);
    expect(resolveExposureWindow({}, now)).toEqual({ from: '2026-09-06', to: '2026-10-03' });
  });

  test('accepts an explicit window and a single day', () => {
    expect(resolveExposureWindow({ from: '2026-09-01', to: '2026-09-30' }, now))
      .toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(resolveExposureWindow({ from: '2026-09-01', to: '2026-09-01' }, now))
      .toEqual({ from: '2026-09-01', to: '2026-09-01' });
  });

  test('accepts exactly MAX_WINDOW_DAYS and refuses one more', () => {
    expect(MAX_WINDOW_DAYS).toBe(366);
    expect(() => resolveExposureWindow({ from: '2025-10-01', to: '2026-10-01' }, now)).not.toThrow();
    expect(() => resolveExposureWindow({ from: '2025-09-30', to: '2026-10-01' }, now))
      .toThrow('at most 366 days');
  });

  test.each([
    [{ from: '2026-9-1', to: '2026-09-30' }, 'YYYY-MM-DD'],
    [{ from: '2026-02-30', to: '2026-03-01' }, 'not a real date'],
    [{ from: '2026-09-30', to: '2026-09-01' }, 'on or before'],
    [{ from: '2026-09-01', to: 'yesterday' }, 'YYYY-MM-DD'],
  ])('refuses %j', (input, message) => {
    expect(() => resolveExposureWindow(input, now)).toThrow(message);
  });
});
