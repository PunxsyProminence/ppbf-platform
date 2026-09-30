/**
 * Render a Postgres DATE the way a person wrote it down.
 *
 * A DATE column is a calendar day, not an instant. db.ts registers a type
 * parser for OID 1082 so the API hands these back verbatim -- "2026-08-15", not
 * a Date shifted into UTC. That care is undone the moment a consumer writes:
 *
 *     new Date(assignment.due_date).toLocaleDateString()
 *
 * because `new Date("2026-08-15")` is parsed as midnight UTC, and
 * toLocaleDateString then renders it in the viewer's zone. Everywhere west of
 * Greenwich -- which is everywhere this platform runs -- that prints the
 * PREVIOUS day. An athlete's drill was due the 15th and their own screen said
 * the 14th.
 *
 * This formats from the parts, so no zone is ever consulted and the day cannot
 * move. Give it a bare 'YYYY-MM-DD'; anything else comes back unchanged rather
 * than guessed at, because a wrong date rendered confidently is worse than an
 * unfamiliar string.
 */
const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function formatCalendarDay(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  const match = CALENDAR_DAY.exec(value.trim());
  if (!match) {
    // Not a bare calendar day. Could be a timestamp, could be something we do
    // not know about. Either way, guessing is how the bug happened.
    return value;
  }

  const [, year, month, day] = match;
  const monthName = MONTHS[Number.parseInt(month, 10) - 1] ?? month;
  return `${monthName} ${Number.parseInt(day, 10)}, ${year}`;
}

/**
 * The calendar day a DATE value names, as 'YYYY-MM-DD', for asking whether two
 * values are the same day.
 *
 * db.ts hands a DATE column back as its 'YYYY-MM-DD' string, but a pg client
 * without that parser (and older test fixtures) produces a Date at LOCAL
 * midnight. Rebuilding the string from local parts inverts that parse in any
 * timezone; toISOString() would not, because it converts to UTC and moves the
 * day backwards everywhere east of Greenwich.
 *
 * Strings are trimmed and otherwise left as they are. A timestamp or any other
 * spelling does not compare equal to a bare day: a guard that asks "is this the
 * same day?" should answer no when it cannot tell, rather than guess yes.
 *
 * Shared by the athlete update route's audit (which fields moved) and
 * assertAthleteUpdateAllowed (an athlete may not move dob), so the two can
 * never disagree about whether a date of birth changed.
 */
export function calendarDayKey(value: unknown): string {
  if (value instanceof Date) {
    const month = `${value.getMonth() + 1}`.padStart(2, '0');
    const day = `${value.getDate()}`.padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }

  return typeof value === 'string' ? value.trim() : String(value);
}
