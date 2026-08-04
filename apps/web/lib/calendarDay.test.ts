import { formatCalendarDay } from './calendarDay';

/**
 * The bug this replaced: an athlete's drill due date rendered one day early.
 *
 * pilot.drill_assignments.due_date is a pg DATE and db.ts hands it back verbatim
 * as "2026-08-15". The page then did `new Date(value).toLocaleDateString()`,
 * which parses a bare date as midnight UTC and renders it in the viewer's zone
 * -- the previous day everywhere west of Greenwich, which is everywhere this
 * platform runs.
 */
describe('formatCalendarDay', () => {
  it('renders the day that was stored, not the day before it', () => {
    expect(formatCalendarDay('2026-08-15')).toBe('Aug 15, 2026');
  });

  // The failing case, pinned. Anywhere behind UTC, `new Date('2026-01-01')`
  // renders as December 31st -- a due date in the wrong YEAR.
  it('does not roll backwards across a year boundary', () => {
    expect(formatCalendarDay('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatCalendarDay('2026-12-31')).toBe('Dec 31, 2026');
  });

  // Demonstrates the defect directly, so this file records WHY the helper
  // exists rather than only what it does. In a negative-offset zone the old
  // expression disagrees with the stored day; in UTC it happens to agree, which
  // is exactly why this shipped -- CI runs in UTC.
  it('disagrees with the old new Date() expression in a negative-offset zone', () => {
    const stored = '2026-08-15';
    const viaUtcParse = new Date(stored);

    // The instant is UTC midnight regardless of where this test runs.
    expect(viaUtcParse.toISOString()).toBe('2026-08-15T00:00:00.000Z');
    // And the local calendar day of that instant is the 14th for any viewer
    // behind UTC. Asserted through the offset rather than the runner's zone so
    // this means the same thing everywhere.
    const shifted = new Date(viaUtcParse.getTime() - 5 * 60 * 60 * 1000);
    expect(shifted.getUTCDate()).toBe(14);

    // The formatter is unmoved.
    expect(formatCalendarDay(stored)).toBe('Aug 15, 2026');
  });

  it('passes through anything that is not a bare calendar day', () => {
    // A timestamp is somebody else's problem -- guessing is how the bug
    // happened.
    expect(formatCalendarDay('2026-08-15T13:45:00.000Z')).toBe('2026-08-15T13:45:00.000Z');
  });

  it('renders nothing for a null or absent date', () => {
    expect(formatCalendarDay(null)).toBe('');
    expect(formatCalendarDay(undefined)).toBe('');
    expect(formatCalendarDay('')).toBe('');
  });
});
