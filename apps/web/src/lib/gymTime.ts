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
 * The server already settled this question: env.ts resolves PPBF_WALL_TIMEZONE
 * and defaults to America/New_York, and wallDisplay.ts does all of its day
 * arithmetic in that zone. This is the client-side half of the same rule.
 *
 * The zone is a literal rather than a read of PPBF_WALL_TIMEZONE because that
 * variable is server-only; a client bundle cannot see it. If the gym ever moves
 * zones, both this constant and the server default have to change together.
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
