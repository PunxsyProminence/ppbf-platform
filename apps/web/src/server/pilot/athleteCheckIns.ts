import { randomUUID } from 'node:crypto';

import {
  SLEEP_HOURS_MAX,
  SLEEP_HOURS_MIN,
  WELLNESS_SCALE_MAX,
  WELLNESS_SCALE_MIN,
} from '@/src/shared/wellnessScales';

import { gymDayIso, type GymTimeInput } from '../../lib/gymTime';

import { query, queryOne } from './db';

// Athlete self check-in (Phase 2 slice 1): the athlete's own "I'm here,
// and this is how I feel" -- one row per athlete per day. Deliberately NOT
// attendance (that stays the coach/terminal register the passbook counts)
// and NOT pilot.readiness -- the readiness board reads that table
// per-athlete-latest, so self-reports landing there would be indistinguishable
// from the staff judgements already in it.
//
// The parenthetical here used to describe pilot.readiness as holding "formula
// scores". It does not: no formula writes to that table, and every score in it
// was typed by staff during intake review (see
// docs/capabilities/READINESS_PROVENANCE_FACTS.md). The decision to keep
// self-reports in their own table is unchanged and still correct -- mixing two
// different kinds of claim in one column is the thing being avoided -- but the
// reason is separation of provenance, not deference to a formula that does not
// exist.
//
// Wellness self-reports are optional -- skipping them is legal and stored as
// null, never defaulted. The set grew from three (energy / soreness / focus)
// to nine by owner decision 2026-08-28, one migration per measure decided;
// what each 1-5 number MEANS lives in src/shared/wellnessScales.ts, which the
// athlete's screen labels from and this module validates against.

export interface AthleteCheckInRow {
  organization_id: string;
  check_in_id: string;
  athlete_id: string;
  checked_in_on: string;
  energy: number | null;
  soreness: number | null;
  focus: number | null;
  // The six added by the extended check-in (owner decision 2026-08-28).
  // sleep_hours is a quantity and reads back as a number; the rest are the
  // same 1-5 self-report as the three above.
  sleep_hours: number | null;
  hydration: number | null;
  motivation: number | null;
  mental_clarity: number | null;
  stress: number | null;
  nutrition_compliance: number | null;
  note: string;
  created_at: string;
}

/**
 * Every 1-5 self-report column.
 *
 * One list rather than repetitions of the same names: the route's validation
 * sweep and the shared scale definitions both derive from it, so a column
 * added by the next measure migration cannot end up written but never
 * validated -- which is what happens when those lists are maintained by hand
 * in parallel. athleteCheckInMeasures.pg.test.ts closes the loop by checking
 * this constant against the constraints on the table itself, because two
 * pieces of code agreeing with each other proves nothing about the schema.
 */
export const WELLNESS_COLUMNS = [
  'energy',
  'soreness',
  'focus',
  'hydration',
  'motivation',
  'mental_clarity',
  'stress',
  'nutrition_compliance',
] as const;

export type WellnessColumn = (typeof WELLNESS_COLUMNS)[number];

/** Returns the reason a wellness value is refused, or null. Absence is
 * legal; a present value must be an integer 1-5.
 *
 * The bounds come from src/shared/wellnessScales.ts, the same module the
 * athlete's screen labels each number from, so the range the server enforces
 * and the range the child is offered cannot drift apart. */
export function wellnessValueError(name: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number'
    || !Number.isInteger(value)
    || value < WELLNESS_SCALE_MIN
    || value > WELLNESS_SCALE_MAX
  ) {
    return `${name} must be a whole number from ${WELLNESS_SCALE_MIN} to ${WELLNESS_SCALE_MAX}, or omitted.`;
  }
  return null;
}

/** Sleep is hours, not a rating, so it has its own rule: any finite number in
 * 0-24, fractional allowed (the control steps in half hours). Absence is
 * legal here too -- an athlete who does not want to say still checks in. */
export function sleepHoursError(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < SLEEP_HOURS_MIN
    || value > SLEEP_HOURS_MAX
  ) {
    return `sleep_hours must be a number from ${SLEEP_HOURS_MIN} to ${SLEEP_HOURS_MAX}, or omitted.`;
  }
  return null;
}

/**
 * WHICH DAY A CHECK-IN BELONGS TO, decided in Node rather than by Postgres.
 *
 * Both halves of this module used to ask the database: the insert left
 * `checked_in_on` to its `default current_date`, and the read matched
 * `checked_in_on = current_date`. That is the DATABASE SERVER'S day, in a
 * zone this application never sets -- and both the production and the staging
 * server report TimeZone = UTC (server parameter, read 2026-09-22), four or
 * five hours ahead of the gym. Once it is past UTC midnight but still the
 * previous day on the wall in Punxsutawney -- from 8pm during daylight time,
 * 7pm during standard time -- the database has already rolled over, so for
 * the back half of every training night a check-in was filed under
 * TOMORROW'S date.
 *
 * The read agreed with the write, which is why nothing looked broken, and
 * both were the wrong day. Monday night's arrival is stored as Tuesday; on
 * Tuesday morning the athlete is told they have already checked in and
 * cannot file Tuesday's own report, and the coach reads Monday night's
 * numbers under Tuesday's heading.
 *
 * The gym's day is the one on the wall in Punxsutawney, and gymDayIso() is
 * where this repo already keeps it -- the attendance register and the coach
 * development log ask it the same question, and blockReview.ts performs the
 * same reduction on the SQL side.
 *
 * The column default stays `current_date`. It is the schema's fallback for
 * some other writer, not this module's answer.
 *
 * WHAT THIS DOES NOT FIX: THE ROWS ALREADY FILED UNDER THE OLD RULE. Every
 * check-in taken after UTC midnight but before local midnight before this
 * ships -- 8pm during daylight time, 7pm during standard time -- is sitting
 * in the table dated the following day, and nothing here moves it. Those rows stay where
 * they are on purpose -- a stored date is a record of what the system did,
 * and rewriting it to match a later rule destroys the evidence that the rule
 * changed -- so both harms above stay reachable for as long as one of those
 * dates is still the gym's today. On that day the athlete is still told they
 * have already checked in and still cannot file that day's own report
 * (checkIn's pre-read finds the mis-dated row), and the coach panel still
 * prints the previous evening's numbers under that day's heading. The window
 * shuts by itself: no mis-dated row is written once this ships, so it lasts
 * at most until the day after the last one was filed. Shutting it sooner
 * means reconciling stored rows, which is a data change, is not this change,
 * and is not something this module can do on its own. Whether any such row
 * exists in production right now has not been checked from here.
 *
 * NULL IS NOT A DAY. There is no honest fallback when gymDayIso() cannot
 * reduce an instant. Letting the write fall back to the column default would
 * store the UTC day, which is the exact defect above; letting the read fall
 * back to null would tell an athlete "no check-in today" without having
 * looked for one. Both are a wrong answer given confidently, so this throws
 * -- the same shape as attendance-today's ATTENDANCE_DAY_UNRESOLVED. No route
 * reaches it: every caller in the app lets `now` default, and a `new Date()`
 * always reduces. The `now` seam below does make it reachable with a
 * caller-supplied value, and athleteCheckIns.pg.test.ts reaches it on purpose
 * -- a throw nothing can ever trigger is a throw nobody can check. It stays
 * a plain Error rather than a PilotError on purpose: per errors.ts, plain
 * means "redact me", and an unresolvable clock is an internal fault, not
 * something the caller can fix by sending different input.
 */
function requireGymDay(value: GymTimeInput = new Date()): string {
  const day = gymDayIso(value);
  if (!day) throw new Error('CHECK_IN_GYM_DAY_UNRESOLVED');
  return day;
}

/** Idempotent by day: checking in twice returns the existing record --
 * arriving is a fact, not a counter. */
export async function checkIn(input: {
  organizationId: string;
  athleteId: string;
  energy?: number | null;
  soreness?: number | null;
  focus?: number | null;
  sleepHours?: number | null;
  hydration?: number | null;
  motivation?: number | null;
  mentalClarity?: number | null;
  stress?: number | null;
  nutritionCompliance?: number | null;
  note?: string;
  /**
   * The instant the gym day is read off, defaulting to now.
   *
   * A seam, not a feature: it exists so a test can stand the clock on the far
   * side of UTC midnight -- 02:30Z is still the previous evening in
   * Punxsutawney -- and watch the REAL reduction run into a real table,
   * rather than faking the system clock out from under the Postgres driver
   * that shares it. No route passes it; an athlete checks in in the present.
   */
  now?: GymTimeInput;
}): Promise<{ row: AthleteCheckInRow; created: boolean } | null> {
  const athlete = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.athletes
     where organization_id = $1 and athlete_id = $2`,
    [input.organizationId, input.athleteId],
  );
  if (!athlete) return null;

  // Resolved ONCE, then used by the pre-read, the insert and the re-read
  // alike. Asking three times would let a tap at the stroke of gym midnight
  // read one day, write the next, and then read back nothing at all.
  const day = requireGymDay(input.now);

  const existing = await checkInOnDay(input.organizationId, input.athleteId, day);
  if (existing) return { row: existing, created: false };

  const checkInId = randomUUID();
  await queryOne(
    `insert into pilot.athlete_check_ins
       (organization_id, check_in_id, athlete_id, checked_in_on,
        energy, soreness, focus, sleep_hours, hydration, motivation,
        mental_clarity, stress, nutrition_compliance, note)
     values ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict (organization_id, athlete_id, checked_in_on) do nothing
     returning check_in_id`,
    [
      input.organizationId,
      checkInId,
      input.athleteId,
      day,
      input.energy ?? null,
      input.soreness ?? null,
      input.focus ?? null,
      input.sleepHours ?? null,
      input.hydration ?? null,
      input.motivation ?? null,
      input.mentalClarity ?? null,
      input.stress ?? null,
      input.nutritionCompliance ?? null,
      input.note ?? '',
    ],
  );

  // Under a concurrent double-tap the conflict clause makes one insert win;
  // both callers read back the same day's row.
  const row = await checkInOnDay(input.organizationId, input.athleteId, day);
  if (!row) return null;
  return { row, created: row.check_in_id === checkInId };
}

/**
 * The row as both readers select it.
 *
 * `sleep_hours` is cast to float8 ON PURPOSE. It is stored `numeric`, and
 * node-postgres hands numeric back as a STRING to protect precision it cannot
 * guarantee in a JS number -- so an uncast select would put "7.5" into a field
 * this module's own interface declares as `number | null`, and every consumer
 * would be entitled to believe it. float8 (OID 701) is parsed as a number, and
 * hours-of-sleep to one decimal is nowhere near the precision where that
 * matters. The date gets ::text for the same class of reason: a JS Date here
 * would carry a timezone the column does not have.
 */
const CHECK_IN_COLUMNS = `
  organization_id, check_in_id, athlete_id, checked_in_on::text as checked_in_on,
  energy, soreness, focus,
  sleep_hours::float8 as sleep_hours,
  hydration, motivation, mental_clarity, stress, nutrition_compliance,
  note, created_at
`;

/**
 * One athlete's row for one named gym day. The day is always a value this
 * module resolved, never a caller's string and never `current_date`, so the
 * read cannot land on a different day than the write did.
 */
async function checkInOnDay(
  organizationId: string,
  athleteId: string,
  day: string,
): Promise<AthleteCheckInRow | null> {
  return queryOne<AthleteCheckInRow>(
    `select ${CHECK_IN_COLUMNS}
     from pilot.athlete_check_ins
     where organization_id = $1 and athlete_id = $2 and checked_in_on = $3::date`,
    [organizationId, athleteId, day],
  );
}

/** Today AT THE GYM -- see requireGymDay for why that is not `current_date`.
 * Resolves the day ONCE and delegates, for the same reason checkIn does.
 * `now` is the same seam checkIn carries and defaults the same way; no route
 * passes it. */
export async function getTodayCheckIn(
  organizationId: string,
  athleteId: string,
  now?: GymTimeInput,
): Promise<AthleteCheckInRow | null> {
  return checkInOnDay(organizationId, athleteId, requireGymDay(now));
}

/** The athlete's own recent history, newest first. One athlete at a time,
 * their own record -- there is no cross-athlete read here. */
export async function listRecentCheckIns(organizationId: string, athleteId: string, limit = 14): Promise<AthleteCheckInRow[]> {
  return query<AthleteCheckInRow>(
    `select ${CHECK_IN_COLUMNS}
     from pilot.athlete_check_ins
     where organization_id = $1 and athlete_id = $2
     order by checked_in_on desc
     limit $3`,
    [organizationId, athleteId, limit],
  );
}
