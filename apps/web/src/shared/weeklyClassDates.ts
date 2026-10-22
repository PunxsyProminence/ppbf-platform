import { addGymDays, gymDayIso } from '@/src/lib/gymTime';

/*
 * REPEAT WEEKLY ON SCHEDULE CLASS (lane LW; pilot readiness 2026-10-20, "NEEDED
 * SOON": every class was made one at a time, and the pilot is the whole gym,
 * OD-2026-10-21-001 D1).
 *
 * The dates a repeating class lands on: the first class's weekday and time, every
 * 7 days at the GYM, so a 6:00 pm class stays at 6:00 pm across a clock change
 * (addGymDays). Shared by the route, which creates exactly these, and the
 * schedule page, which shows them before anything is sent. Each date becomes an
 * ordinary, independent class; nothing here or in the database ties them together.
 *
 * Copy is PROPOSED.
 */

export const REPEAT_WEEKS_MAX = 12;
export const REPEAT_WEEKS_DEFAULT = 4;

/** For a number of weeks (the first class counts as week 1), or until a gym date ('YYYY-MM-DD'), inclusive. */
export type WeeklyRepeat = { weeks: number } | { until: string };

export interface ClassTimes {
  start: Date;
  end: Date;
}

export type WeeklyPlan = { ok: true; classes: ClassTimes[] } | { ok: false; error: string };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date: V8 reads '2026-02-30' as March 2, so the round trip has to match. */
function isCalendarDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function weeklyClassDates(first: ClassTimes, repeat: WeeklyRepeat): WeeklyPlan {
  // Week 0 is the first class exactly as given, never re-solved through the gym clock.
  const at = (week: number): ClassTimes =>
    week === 0 ? first : { start: addGymDays(first.start, 7 * week), end: addGymDays(first.end, 7 * week) };

  if ('weeks' in repeat) {
    const { weeks } = repeat;
    if (!Number.isInteger(weeks) || weeks < 1 || weeks > REPEAT_WEEKS_MAX) {
      return { ok: false, error: `Repeat weekly runs for 1 to ${REPEAT_WEEKS_MAX} weeks.` };
    }
    return { ok: true, classes: Array.from({ length: weeks }, (_, week) => at(week)) };
  }

  const until = repeat.until.trim();
  if (!isCalendarDate(until)) {
    return { ok: false, error: 'The repeat end date must be a date.' };
  }
  const classes: ClassTimes[] = [];
  // One past the limit, so an end date beyond it is refused rather than cut short unseen.
  for (let week = 0; week <= REPEAT_WEEKS_MAX; week += 1) {
    const next = at(week);
    const day = gymDayIso(next.start);
    if (!day || day > until) break;
    classes.push(next);
  }
  if (classes.length === 0) {
    return { ok: false, error: 'The repeat end date is before the first class.' };
  }
  if (classes.length > REPEAT_WEEKS_MAX) {
    return { ok: false, error: `Repeat weekly runs for at most ${REPEAT_WEEKS_MAX} weeks. Pick an earlier end date.` };
  }
  return { ok: true, classes };
}
