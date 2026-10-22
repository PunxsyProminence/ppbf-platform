import { defaultStaffAttendanceClassId, type PickableClass } from './attendanceDefaultClass';

// Pilot blocker B2: the staff attendance picker opened on the oldest class on the list. The clock
// is pinned so each case is about the gym's day, not the day the suite runs. The gym keeps
// America/New_York time: 2026-10-21T22:50Z is 6:50 PM on October 21 there.

const NOW = Date.parse('2026-10-21T22:50:00.000Z');

function cls(class_id: string, start_at: string, end_at: string, status = 'open'): PickableClass {
  return { class_id, start_at, end_at, status };
}

// As the scheduler lists them: oldest first.
const OLD_TEST_CLASS = cls('old', '2026-10-05T22:00:00.000Z', '2026-10-05T23:00:00.000Z');
const LAST_NIGHT = cls('last-night', '2026-10-20T23:00:00.000Z', '2026-10-21T00:00:00.000Z');
const TONIGHT_6PM = cls('tonight-6', '2026-10-21T22:00:00.000Z', '2026-10-21T23:00:00.000Z');
const TONIGHT_8PM = cls('tonight-8', '2026-10-22T00:00:00.000Z', '2026-10-22T01:00:00.000Z');
const TOMORROW = cls('tomorrow', '2026-10-22T22:00:00.000Z', '2026-10-22T23:00:00.000Z');

describe('the class the staff attendance picker opens on', () => {
  test('the class running now, not the oldest on the list', () => {
    expect(defaultStaffAttendanceClassId([OLD_TEST_CLASS, LAST_NIGHT, TONIGHT_6PM, TONIGHT_8PM, TOMORROW], NOW)).toBe('tonight-6');
  });

  test('ten minutes before tonight\'s first class, that class', () => {
    expect(defaultStaffAttendanceClassId([OLD_TEST_CLASS, TONIGHT_6PM, TONIGHT_8PM], Date.parse('2026-10-21T21:50:00.000Z'))).toBe('tonight-6');
  });

  test('between two classes today, the nearer one by its start or its end', () => {
    // 7:20 PM: the 6-7 class ended 20 minutes ago, the 8 PM class is 40 minutes away.
    expect(defaultStaffAttendanceClassId([TONIGHT_6PM, TONIGHT_8PM], Date.parse('2026-10-21T23:20:00.000Z'))).toBe('tonight-6');
    // 7:45 PM: the 8 PM class is 15 minutes away.
    expect(defaultStaffAttendanceClassId([TONIGHT_6PM, TONIGHT_8PM], Date.parse('2026-10-21T23:45:00.000Z'))).toBe('tonight-8');
  });

  test('a cancelled class is never the default, even when it is the one running now', () => {
    const cancelled = { ...TONIGHT_6PM, status: 'cancelled' };
    expect(defaultStaffAttendanceClassId([OLD_TEST_CLASS, cancelled, TONIGHT_8PM], NOW)).toBe('tonight-8');
  });

  test('with no class today, the latest class that has already begun', () => {
    expect(defaultStaffAttendanceClassId([OLD_TEST_CLASS, LAST_NIGHT, TOMORROW], NOW)).toBe('last-night');
  });

  test('with every class still ahead, the next one', () => {
    const later = cls('later', '2026-10-29T22:00:00.000Z', '2026-10-29T23:00:00.000Z');
    expect(defaultStaffAttendanceClassId([TOMORROW, later], NOW)).toBe('tomorrow');
  });

  test('a class whose start does not read is skipped; one whose end does not read is placed by its start', () => {
    const noStart = cls('no-start', 'not a date', '2026-10-21T23:00:00.000Z');
    const noEnd = cls('no-end', '2026-10-21T22:40:00.000Z', '');
    expect(defaultStaffAttendanceClassId([noStart, OLD_TEST_CLASS], NOW)).toBe('old');
    expect(defaultStaffAttendanceClassId([OLD_TEST_CLASS, noEnd], NOW)).toBe('no-end');
  });

  test('no class that is not cancelled: nothing to open on', () => {
    expect(defaultStaffAttendanceClassId([], NOW)).toBeNull();
    expect(defaultStaffAttendanceClassId([{ ...TONIGHT_6PM, status: 'cancelled' }], NOW)).toBeNull();
  });
});
