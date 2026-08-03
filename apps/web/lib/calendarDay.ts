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
