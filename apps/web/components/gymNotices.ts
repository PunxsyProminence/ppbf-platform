/**
 * THE GYM NOTICING — the two remarks that need a clock, kept away from the one
 * file that must never have one.
 *
 * milestoneCeremony.ts is load-bearing precisely because it cannot read a
 * date. A file that can read a clock can subtract two of them; a file that can
 * subtract two clocks can notice an absence; and this platform runs a Layer 11
 * safety gate that locks children out for medical reasons. "You have not been
 * in for three weeks" is a sentence that must be unwritable, not merely
 * unwritten — so the clock lives here, behind two rules that are the whole
 * design of this file:
 *
 *   RULE 1 — NOTHING HERE IS EVER HANDED AN ATTENDANCE HISTORY. Not a list of
 *   sessions, not a last-seen date, not a count. The anniversary takes exactly
 *   two dates: when the record starts, and what day it is. Elapsed calendar
 *   time is not attendance, and no arrangement of the arguments below can
 *   reconstruct attendance from them.
 *
 *   RULE 2 — EVERY OUTPUT IS ADDITIVE. These functions return a remark or they
 *   return null. There is no state to lose, nothing expires, nothing is taken
 *   back, and there is no branch anywhere in this file that produces a worse
 *   answer for a longer gap. That is checked by tests rather than trusted.
 *
 * TONE. These are the gym noticing, not the app congratulating. One line, dry,
 * no exclamation mark, no confetti, no badge, no comparison to anybody else.
 * A gym that has been open forty years does not throw a party because somebody
 * turned up early; a coach glances at the clock and says something short.
 */

/* ---------------------------------------------------------------- BEFORE DAWN */

/**
 * The window. Not "night", which would catch the 11pm shift worker checking a
 * schedule and say something faintly accusing to them; this is specifically
 * the person who is up and doing gym business before the sun is.
 *
 * Local hours, because "before dawn" is a fact about the room the person is
 * standing in, and the server's timezone is a fact about a datacentre.
 */
const DAWN_FROM_HOUR = 4;
const DAWN_UNTIL_HOUR = 6;

/**
 * One dry line for somebody who is here before six, or null.
 *
 * Deliberately not personalised and deliberately not stored: it is true while
 * it is true and says nothing about how often it has been true, because how
 * often is a cadence and this file does not do cadence.
 */
export function beforeDawnNote(now: Date): string | null {
  const hour = now.getHours();
  if (hour < DAWN_FROM_HOUR || hour >= DAWN_UNTIL_HOUR) {
    return null;
  }
  return 'Before six. Somebody always is.';
}

/* ---------------------------------------------------------------- ANNIVERSARY */

/**
 * How long after the date the mark still stands.
 *
 * Zero would mean an athlete who trains Tuesdays and Thursdays misses their own
 * anniversary in five years out of seven, which is a mark that mostly does not
 * happen. A week is long enough that anyone who comes in at all will see it,
 * and short enough that it is still about the day.
 */
const ANNIVERSARY_GRACE_DAYS = 6;

export interface AnniversaryMark {
  /** Whole years, always 1 or more. */
  readonly years: number;
  /** The line. Theirs — no comparison, no rank, no leaderboard. */
  readonly line: string;
}

/** Calendar days from a to b, both read as plain local dates. */
function daysBetween(a: Date, b: Date): number {
  const from = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const to = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((to - from) / 86_400_000);
}

/**
 * Parse a plain YYYY-MM-DD (or the front of an ISO timestamp) as a LOCAL date.
 *
 * `new Date('2025-03-04')` is parsed as UTC midnight by specification, which in
 * every timezone west of Greenwich is the 3rd — so a naive parse moves an
 * athlete's anniversary a day earlier for most of the United States, this gym
 * included. The date is written down as a calendar day and has to be read back
 * as one.
 */
function parseCalendarDate(raw: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  if (!match) {
    return null;
  }
  const [, y, m, d] = match;
  const date = new Date(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A year at the gym, noticed quietly — or null, which is the answer on 358
 * days out of 365 and on every day of somebody's first year.
 *
 * @param firstSessionDate the earliest session on the record, YYYY-MM-DD
 * @param now              today
 *
 * WHAT IT CANNOT DO, by construction: it is handed the START of a record and
 * the current day. It never sees the sessions in between, so it cannot tell a
 * person who trained every week for a year from a person who came twice, and
 * it says the same thing to both. That is not a limitation to be fixed later.
 * It is the feature — the mark is for staying, not for attending, and staying
 * is the thing a gym should notice about a child who had a hard year.
 */
export function anniversaryMark(firstSessionDate: string, now: Date): AnniversaryMark | null {
  const start = parseCalendarDate(firstSessionDate);
  if (!start) {
    return null;
  }

  const elapsed = daysBetween(start, now);
  if (elapsed < 0) {
    // A start date in the future is a bad row, not an anniversary.
    return null;
  }

  // Whole years by calendar, not by dividing days — leap years make 365 the
  // wrong constant one year in four, and an anniversary that lands a day late
  // every fourth year is the kind of thing nobody reports and everybody
  // notices.
  let years = now.getFullYear() - start.getFullYear();
  const beforeTheDay =
    now.getMonth() < start.getMonth()
    || (now.getMonth() === start.getMonth() && now.getDate() < start.getDate());
  if (beforeTheDay) {
    years -= 1;
  }

  if (years < 1) {
    return null;
  }

  // The most recent anniversary, and how long ago it was.
  const mostRecent = new Date(start.getFullYear() + years, start.getMonth(), start.getDate());
  const sinceTheDay = daysBetween(mostRecent, now);
  if (sinceTheDay < 0 || sinceTheDay > ANNIVERSARY_GRACE_DAYS) {
    return null;
  }

  return {
    years,
    line: years === 1
      ? 'A year, this week. Same gym, same door.'
      : `${years} years, this week. Same gym, same door.`,
  };
}

/* ------------------------------------------------------- THE DRAWER, FOUND */

/**
 * The nod for somebody who has worked out that ⌘K exists and has kept using
 * it. Not a tutorial, not a badge — one line, once, and then the gym never
 * mentions it again.
 *
 * A COUNT OF OPENS IS NOT A CADENCE. It only goes up, it is never compared to
 * a clock, and there is no number of opens that produces a worse outcome than
 * a smaller one. Somebody who opens the catalog five times in a minute and
 * somebody who opens it five times across a year get the identical line, which
 * is the same property the training card's count has and for the same reason.
 */
export const CATALOG_OPENS_KEY = 'ppbf.catalog.opens';

/** Where the nod lands. Late enough to be a habit, early enough to still be a first week. */
export const CATALOG_NOD_AT = 5;

export function catalogNod(opens: number): string | null {
  return opens === CATALOG_NOD_AT
    ? 'Fifth time. You know where the drawer is now.'
    : null;
}

/**
 * Read, increment and write the open count in one call, returning the new
 * value. Storage failures degrade to "this is the first time", which costs a
 * line nobody was promised and never double-counts.
 */
export function recordCatalogOpen(): number {
  let opens = 1;
  try {
    const raw = globalThis.localStorage?.getItem(CATALOG_OPENS_KEY);
    const parsed = raw === null || raw === undefined ? 0 : Number.parseInt(raw, 10);
    opens = (Number.isFinite(parsed) && parsed > 0 ? parsed : 0) + 1;
    globalThis.localStorage?.setItem(CATALOG_OPENS_KEY, String(opens));
  } catch {
    // Private mode, locked-down kiosk webview. A remark is never worth a throw.
  }
  return opens;
}
