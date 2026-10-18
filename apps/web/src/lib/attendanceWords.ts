import { formatGymDateNumeric } from './gymTime';

// Words for the 28-day attendance figure and the last day marked present
// (OD-2026-10-17-026 (c)), shared by the coach's athlete view and
// /coach/performance-analytics so both say the same thing. They say where the
// numbers come from -- the CLASS REGISTER (pilot.attendance_reconciled) -- and
// the denominator: the rate counts the days the register marked, so a day
// nobody marked is not an absence, a missing register is not 0%, and a day
// trained but not marked on the register (for example only in a live
// session) is not seen. All wording PROPOSED.

export interface AttendanceWindowView {
  window_from: string;
  window_to: string;
  days_present: number;
  days_absent: number;
  days_excused: number;
  attendance_rate: number | null;
  last_present_day: string | null;
  days_since_last_present: number | null;
}

export function isAttendanceWindow(value: unknown): value is AttendanceWindowView {
  const row = value as Record<string, unknown> | null;
  if (!row || typeof row !== 'object') return false;
  const counts = [row.days_present, row.days_absent, row.days_excused].every(
    (n) => typeof n === 'number' && Number.isInteger(n) && n >= 0,
  );
  return counts
    && typeof row.window_from === 'string' && typeof row.window_to === 'string'
    && (row.attendance_rate === null || (typeof row.attendance_rate === 'number' && row.attendance_rate >= 0 && row.attendance_rate <= 1))
    && (row.last_present_day === null || typeof row.last_present_day === 'string')
    && (row.days_since_last_present === null || (typeof row.days_since_last_present === 'number' && row.days_since_last_present >= 0));
}

function day(iso: string): string {
  return formatGymDateNumeric(`${iso}T12:00:00Z`) ?? iso;
}

/** "9/21/2026 to 10/18/2026": the days the figure covers. */
export function attendanceWindowWords(window: AttendanceWindowView): string {
  return `${day(window.window_from)} to ${day(window.window_to)}`;
}

/** "75% (present 3 of 4 days marked on the class register, 1 excused)" or "No class register in the last 28 days". */
export function attendanceRateWords(window: AttendanceWindowView): string {
  const marked = window.days_present + window.days_absent;
  if (marked === 0) {
    return window.days_excused > 0
      ? `No present or absent marks on the class register in the last 28 days (${window.days_excused} excused)`
      : 'No class register in the last 28 days';
  }
  // Worked out from the counts, so the whole percent is never rounded twice.
  const percent = Math.round((100 * window.days_present) / marked);
  const excused = window.days_excused > 0 ? `, ${window.days_excused} excused` : '';
  return `${percent}% (present ${window.days_present} of ${marked} day${marked === 1 ? '' : 's'} marked on the class register${excused})`;
}

/** "Last marked present on the class register 12 days ago (10/6/2026)", "today", or not at all. */
export function daysSinceWords(window: AttendanceWindowView): string {
  if (window.days_since_last_present === null || window.last_present_day === null) {
    return 'Not marked present on the class register';
  }
  if (window.days_since_last_present === 0) return 'Marked present on the class register today';
  const n = window.days_since_last_present;
  return `Last marked present on the class register ${n} day${n === 1 ? '' : 's'} ago (${day(window.last_present_day)})`;
}
