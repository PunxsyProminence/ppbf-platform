import {
  formatGymDate,
  formatGymDateShort,
  formatGymDateTime,
  formatGymDay,
  GYM_TIME_ZONE,
} from './gymTime';

/**
 * The bug these pin: components formatted dates with
 * `toLocaleDateString(undefined, ...)`, which uses the VIEWER's timezone. CI
 * runs in UTC, so the suite was green while the same code rendered the previous
 * day on every machine in America/New_York -- including every machine in
 * Punxsutawney. thenAndNow.test.tsx failed locally and passed in CI for exactly
 * this reason.
 */
describe('gym-local date formatting', () => {
  test('midnight UTC is still the same calendar day at the gym', () => {
    // 2026-01-12T00:00:00Z is 7pm on January 11 in America/New_York. The naive
    // formatter therefore rendered "January 11" for a milestone the record says
    // was awarded on the 12th.
    expect(formatGymDate('2026-01-12T00:00:00Z')).toBe('January 11, 2026');
  });

  test('an evening session keeps the day the gym was actually open', () => {
    // 7:30pm ET on January 12 -- the case the naive formatter got right by
    // accident, and which a blunt "just use UTC" fix would break by rolling it
    // forward to the 13th.
    expect(formatGymDate('2026-01-13T00:30:00Z')).toBe('January 12, 2026');
  });

  test('holds across the daylight-saving boundary', () => {
    // EST (UTC-5) before, EDT (UTC-4) after. A fixed numeric offset would get
    // one of these wrong; a named zone gets both right.
    expect(formatGymDate('2026-03-08T04:30:00Z')).toBe('March 7, 2026');
    expect(formatGymDate('2026-03-09T03:30:00Z')).toBe('March 8, 2026');
  });

  test('renders identically regardless of the viewer, by construction', () => {
    // Both the locale and the zone are pinned, so there is no viewer-dependent
    // input left for the formatter to vary on.
    expect(GYM_TIME_ZONE).toBe('America/New_York');
    expect(formatGymDateShort('2026-07-20T00:00:00Z')).toBe('Jul 19, 2026');
  });

  test('date and time read as one gym-local instant', () => {
    expect(formatGymDateTime('2026-08-01T23:15:00Z')).toBe('August 1, 2026 at 7:15 PM');
  });

  test('a calendar date is never moved by a timezone', () => {
    // The sessions list returns `date: '2026-01-12'` -- already reduced to a
    // day, carrying no zone. Converting it can only be wrong, and converting it
    // westward is what rendered day one as January 11.
    expect(formatGymDay('2026-01-12')).toBe('January 12, 2026');
    expect(formatGymDay('2026-03-08')).toBe('March 8, 2026');
  });

  test('an instant still resolves to the gym-local day', () => {
    // Same helper, other branch: `date` is absent and the caller falls back to
    // created_at, which IS an instant and does need converting.
    expect(formatGymDay('2026-01-12T18:00:00Z')).toBe('January 12, 2026');
    expect(formatGymDay('2026-01-12T00:00:00Z')).toBe('January 11, 2026');
  });

  test('unusable input yields null rather than "Invalid Date"', () => {
    for (const input of [null, undefined, '', 'not-a-date']) {
      expect(formatGymDate(input)).toBeNull();
      expect(formatGymDateShort(input)).toBeNull();
      expect(formatGymDateTime(input)).toBeNull();
      expect(formatGymDay(input)).toBeNull();
    }
  });
});
