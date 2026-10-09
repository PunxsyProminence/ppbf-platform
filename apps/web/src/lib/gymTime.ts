/**
 * Dates shown to people are the GYM's dates, not the viewer's.
 *
 * Every date in this platform describes something that happened at a gym in
 * Punxsutawney: a session attended, a milestone awarded, a coach's note signed.
 * `toLocaleDateString(undefined, ...)` renders those instants in whatever
 * timezone the viewer's device is set to, which produces two wrong answers:
 *
 *   - A milestone stamped 2026-01-12T00:00:00Z displays as "January 11" for
 *     everyone in America/New_York, because midnight UTC is 7pm the previous
 *     evening there. Day one of an athlete's record showed the wrong day.
 *   - A grandparent watching from another timezone sees different dates than
 *     the coach who wrote them, for the same events.
 *
 * This constant is the ONE source of the gym's zone, for client and server
 * alike: env.ts getWallTimeZone() returns it, and wallDisplay.ts does all of
 * its day arithmetic in it. It is a literal, not an environment variable,
 * because a client bundle cannot read a server-only variable and two sources
 * would let the board's day drift from every other date shown.
 */
export const GYM_TIME_ZONE = 'America/New_York';

/**
 * en-US rather than the viewer's locale, for the same reason as the timezone:
 * a date written by a coach should read identically to everyone who sees it.
 */
const GYM_LOCALE = 'en-US';

/** Accepts an ISO string or a Date, because call sites have both. */
export type GymTimeInput = string | number | Date | null | undefined;

function parse(value: GymTimeInput): Date | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Formats a value that may be either a calendar date ('2026-01-12') or an
 * instant ('2026-01-12T18:00:00Z'), which is exactly what the sessions list
 * returns: `item.date ?? item.created_at`.
 *
 * The two need opposite treatment, and conflating them is what produced the
 * original bug. An instant has to be converted into the gym's zone to name the
 * right day. A calendar date has already been reduced to a day and carries no
 * zone -- converting it can only move it. 'YYYY-MM-DD' parses as UTC midnight,
 * so any shift into a western zone lands on the day before, which is how a
 * session recorded for January 12 came to display as January 11.
 */
export function formatGymDay(value: GymTimeInput): string | null {
  if (!value) return null;
  if (typeof value === 'string' && DATE_ONLY.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return null;
    // Formatted in UTC deliberately: it was parsed as UTC midnight, so UTC is
    // the only zone that returns the same calendar day it started as.
    return parsed.toLocaleDateString(GYM_LOCALE, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }
  return formatGymDate(value);
}

/** "January 12, 2026" in the gym's timezone, or null if the input is unusable. */
export function formatGymDate(iso: GymTimeInput): string | null {
  const parsed = parse(iso);
  if (!parsed) return null;
  return parsed.toLocaleDateString(GYM_LOCALE, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: GYM_TIME_ZONE,
  });
}

/** "Jan 12, 2026" -- the compact form, for tables and chips. */
export function formatGymDateShort(iso: GymTimeInput): string | null {
  const parsed = parse(iso);
  if (!parsed) return null;
  return parsed.toLocaleDateString(GYM_LOCALE, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: GYM_TIME_ZONE,
  });
}

/** "January 12, 2026 at 7:30 PM" in the gym's timezone. */
export function formatGymDateTime(iso: GymTimeInput): string | null {
  const parsed = parse(iso);
  if (!parsed) return null;
  const date = formatGymDate(iso);
  const time = parsed.toLocaleTimeString(GYM_LOCALE, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: GYM_TIME_ZONE,
  });
  return `${date} at ${time}`;
}

/**
 * "Aug 12, 2026, 7:30 PM" -- the compact form of formatGymDateTime, for table
 * cells and other tight spaces that formatGymDateTime's full month name
 * doesn't fit.
 */
export function formatGymDateTimeShort(iso: string | null | undefined): string | null {
  const parsed = parse(iso);
  if (!parsed) return null;
  const date = formatGymDateShort(iso);
  const time = parsed.toLocaleTimeString(GYM_LOCALE, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: GYM_TIME_ZONE,
  });
  return `${date}, ${time}`;
}

/**
 * "Aug 12" -- a calendar date (see formatGymDay) with no year, for chart axis
 * and chip labels where the year is implied by context.
 */
export function formatGymDayShort(value: string | null | undefined): string | null {
  if (!value) return null;
  if (DATE_ONLY.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toLocaleDateString(GYM_LOCALE, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
  }
  const parsed = parse(value);
  if (!parsed) return null;
  return parsed.toLocaleDateString(GYM_LOCALE, {
    month: 'short',
    day: 'numeric',
    timeZone: GYM_TIME_ZONE,
  });
}

/**
 * "3/8/2026" -- the numeric form, for dense tables. Replaces a bare
 * `toLocaleDateString()`, which took both the locale AND the zone from the
 * viewer's device.
 */
export function formatGymDateNumeric(value: GymTimeInput): string | null {
  const parsed = parse(value);
  if (!parsed) return null;
  return parsed.toLocaleDateString(GYM_LOCALE, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    timeZone: GYM_TIME_ZONE,
  });
}

/**
 * Today's calendar day AT THE GYM, as 'YYYY-MM-DD'.
 *
 * WHY THIS IS NOT `new Date().toISOString().slice(0, 10)`. That is the day in
 * UTC, and the gym is four or five hours behind it. Every evening session
 * after 8pm ET falls on the following UTC day, so a "today" computed that way
 * is tomorrow for the whole back half of every training night. Two callers
 * depend on this in opposite directions: the register would ask the database
 * about tomorrow, and the development log would either refuse the work a coach
 * has just finished or accept a date that has not arrived.
 *
 * It is the same drift pilot.attendance_reconciled avoids by converting
 * scheduler timestamps in America/New_York, and the one gymTimeDrift.test.ts
 * pins on the front end.
 *
 * Assembled from formatToParts rather than a locale string: 'en-CA' happens
 * to render ISO order today, and a date this load-bearing should not rest on
 * that continuing to be true.
 */
export function gymDayIso(value: GymTimeInput = new Date()): string | null {
  const parsed = parse(value);
  if (!parsed) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: GYM_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(parsed);
  const at = (type: string) => parts.find((part) => part.type === type)?.value;
  const [year, month, day] = [at('year'), at('month'), at('day')];
  return year && month && day ? `${year}-${month}-${day}` : null;
}

/** "7:15 PM" at the gym. */
export function formatGymTimeOfDay(value: GymTimeInput): string | null {
  const parsed = parse(value);
  if (!parsed) return null;
  return parsed.toLocaleTimeString(GYM_LOCALE, {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: GYM_TIME_ZONE,
  });
}

/**
 * "19:15" or "19:15:04" at the gym -- the 24-hour form the SHADOW and research
 * consoles use for log-style timestamps.
 */
export function formatGymClock24(value: GymTimeInput, options: { seconds?: boolean } = {}): string | null {
  const parsed = parse(value);
  if (!parsed) return null;
  return parsed.toLocaleTimeString(GYM_LOCALE, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    ...(options.seconds ? { second: '2-digit' as const } : {}),
    timeZone: GYM_TIME_ZONE,
  });
}

/** "Monday" at the gym. */
export function formatGymWeekday(value: GymTimeInput): string | null {
  const parsed = parse(value);
  if (!parsed) return null;
  return parsed.toLocaleDateString(GYM_LOCALE, { weekday: 'long', timeZone: GYM_TIME_ZONE });
}

/** "Mar 8" at the gym -- month and day, no year. */
export function formatGymMonthDay(value: GymTimeInput): string | null {
  const parsed = parse(value);
  if (!parsed) return null;
  return parsed.toLocaleDateString(GYM_LOCALE, {
    month: 'short',
    day: 'numeric',
    timeZone: GYM_TIME_ZONE,
  });
}

/**
 * "March 8, 2026 at 7:15 PM" -- the full stamp used where a record's exact
 * moment matters (uploads, check-ins, generated reports). Replaces a bare
 * `toLocaleString()`.
 */
export function formatGymStamp(value: GymTimeInput): string | null {
  const parsed = parse(value);
  if (!parsed) return null;
  const date = formatGymDate(parsed);
  const time = formatGymTimeOfDay(parsed);
  return date && time ? `${date} at ${time}` : null;
}

/**
 * Escape hatch for call sites with a bespoke option set (weekday + time,
 * month/day + hour, and so on). Pins the locale and the zone and lets the
 * caller choose the rest -- the point is that neither of those two is ever the
 * viewer's to decide.
 */
export function formatGymCustom(
  value: GymTimeInput,
  options: Intl.DateTimeFormatOptions,
): string | null {
  const parsed = parse(value);
  if (!parsed) return null;
  return parsed.toLocaleString(GYM_LOCALE, { ...options, timeZone: GYM_TIME_ZONE });
}

/**
 * A number in the gym's locale, for money and counts.
 *
 * Not a date function, but it belongs here for the same reason the rest do:
 * this module exists to stop a viewer's device deciding how a gym's records
 * read, and grouping separators are decided by locale exactly as timezones are.
 * A board member opening the grant table on a device set to de-DE saw
 * "$1.234" where the ledger says "$1,234".
 *
 * It also keeps src/lib/gymTimeDrift.test.ts honest. That ratchet matches
 * /\.toLocale(Date|Time)?String\s*\(/, and the optional group means a bare
 * Number.prototype.toLocaleString() trips a test written about timezones. The
 * right answer is to pin the locale rather than to widen the prohibition or
 * grandfather a file that never had a date bug in it.
 */
export function formatGymNumber(
  value: number | null | undefined,
  options: Intl.NumberFormatOptions = {},
): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return '';
  }
  return new Intl.NumberFormat(GYM_LOCALE, options).format(value);
}

/* ------------------------------------------------- typed wall-clock -> instant -- */

/**
 * A date-time as a person types it into a `datetime-local` field:
 * 'YYYY-MM-DDTHH:mm', optionally with seconds and fractions, 'T' or a space.
 * Nothing after the time, so no 'Z' and no offset.
 */
const ZONELESS_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;

/** The gym zone's wall-clock fields for an instant, as UTC-style numbers. */
function gymWallFields(instant: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: GYM_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const at = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  // Date.UTC treats the wall-clock numbers as if they were UTC, which makes
  // (this - instant) the zone's offset at that instant.
  return Date.UTC(at('year'), at('month') - 1, at('day'), at('hour') % 24, at('minute'), at('second'));
}

/**
 * The instant at which the gym's wall clock reads the given wall-clock time.
 *
 * Solved twice, the same way zonedMidnightUtc in src/server/pilot/wallDisplay.ts
 * solves local midnight: the offset that applies at the answer is the offset
 * needed to find it, so one pass lands an hour out on the two days a year the
 * clocks move. That fixes the two awkward cases:
 *   - a time that exists twice (clocks fall back, 1:30 am on the first Sunday
 *     of November) resolves to the FIRST one, the daylight-time instant;
 *   - a time that does not exist (clocks spring forward, 2:30 am on the second
 *     Sunday of March) resolves to the same wall time on the standard-time
 *     side, i.e. 1:30 am EST, one hour earlier than the gap.
 * Both are what zonedMidnightUtc would return for the same input; the gym does
 * not hold classes in either window.
 */
function gymWallClockToUtc(naiveUtc: number): Date {
  let guess = new Date(naiveUtc);
  for (let i = 0; i < 2; i += 1) {
    guess = new Date(naiveUtc - (gymWallFields(guess) - guess.getTime()));
  }
  return guess;
}

/**
 * Reads a date-time string as the instant it means AT THE GYM.
 *
 * `new Date('2026-09-01T18:00')` reads a zone-less string in the zone of
 * whatever process runs it. On a UTC server that stores 6:00 pm as 18:00Z,
 * which the gym then displays as 2:00 pm. A coach typing a class time means the
 * gym's clock, so a string with no zone is read as gym time.
 *
 * A string that carries its own zone ('Z' or an offset) is honoured as sent.
 * Returns null when the text is not a date-time at all (including impossible
 * ones such as February 30), so callers keep their own error message.
 * Anything that is not an ISO date-time with a time part (a bare 'YYYY-MM-DD',
 * free text) is left to `new Date`, as before.
 */
export function parseInstantAsGymTime(value: string): Date | null {
  const text = value.trim();
  const match = ZONELESS_DATE_TIME.exec(text);
  if (!match) {
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const [, y, mo, d, h, mi, s, frac] = match;
  const [year, month, day, hour, minute, second] = [y, mo, d, h, mi, s ?? '0'].map(Number);
  const millis = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
  const naive = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  // Date.UTC rolls an impossible field over (Feb 30 -> Mar 2); reject it.
  if (
    naive.getUTCFullYear() !== year || naive.getUTCMonth() !== month - 1 || naive.getUTCDate() !== day ||
    hour > 23 || minute > 59 || second > 59
  ) {
    return null;
  }
  // Solved on whole seconds: gymWallFields drops milliseconds, so a fraction
  // inside the solve would skew the offset. Added back afterwards.
  return new Date(gymWallClockToUtc(naive.getTime()).getTime() + millis);
}
