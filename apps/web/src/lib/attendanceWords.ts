import { formatGymDateNumeric } from './gymTime';

// Words for the 28-day attendance figure and the days since the last session
// (OD-2026-10-17-026 (c)), shared by the coach's athlete view and
// /coach/performance-analytics so both say the same thing. The denominator is
// always said out loud: the rate counts the days the register marked, so a
// day nobody marked is not an absence and a missing register is not 0%.
// All wording PROPOSED.

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

/** "75% (present 3 of 4 marked days, 1 excused)" or "No register in the last 28 days". */
export function attendanceRateWords(window: AttendanceWindowView): string {
  if (window.attendance_rate === null) {
    return window.days_excused > 0
      ? `No present or absent marks in the last 28 days (${window.days_excused} excused)`
      : 'No register in the last 28 days';
  }
  const marked = window.days_present + window.days_absent;
  const excused = window.days_excused > 0 ? `, ${window.days_excused} excused` : '';
  return `${Math.round(window.attendance_rate * 100)}% (present ${window.days_present} of ${marked} marked day${marked === 1 ? '' : 's'}${excused})`;
}

/** "12 days since the last session (10/6/2026)", "Trained today", or "Never marked present". */
export function daysSinceWords(window: AttendanceWindowView): string {
  if (window.days_since_last_present === null || window.last_present_day === null) return 'Never marked present';
  if (window.days_since_last_present === 0) return 'Trained today';
  const n = window.days_since_last_present;
  return `${n} day${n === 1 ? '' : 's'} since the last session (${day(window.last_present_day)})`;
}
