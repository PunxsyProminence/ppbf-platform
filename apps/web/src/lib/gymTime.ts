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

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const parsed = new Date(iso);
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
export function formatGymDay(value: string | null | undefined): string | null {
  if (!value) return null;
  if (DATE_ONLY.test(value)) {
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
export function formatGymDate(iso: string | null | undefined): string | null {
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
export function formatGymDateShort(iso: string | null | undefined): string | null {
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
export function formatGymDateTime(iso: string | null | undefined): string | null {
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
