/**
 * How a class-register mark was made, in the words a coach reads on the floor
 * (the stored value is `coach_override`, `walk_in` and so on, which /schedule
 * used to print as it was). One map, so /schedule's records list and the class
 * screen's "Who is here" (lane 6C7, U2-6c) say the same thing about the same
 * mark.
 */
export const ATTENDANCE_METHOD_WORDS = {
  self: 'self check-in',
  parent: 'parent',
  coach_override: 'coach',
  admin_override: 'admin',
  walk_in: 'walk-in',
} as const;

export type AttendanceMethod = keyof typeof ATTENDANCE_METHOD_WORDS;

/** The words for a stored method, or null for a value this build does not know (never the raw value). */
export function attendanceMethodWords(method: unknown): string | null {
  return typeof method === 'string' && Object.prototype.hasOwnProperty.call(ATTENDANCE_METHOD_WORDS, method)
    ? ATTENDANCE_METHOD_WORDS[method as AttendanceMethod]
    : null;
}
