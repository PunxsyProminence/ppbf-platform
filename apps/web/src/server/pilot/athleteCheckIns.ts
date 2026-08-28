import { randomUUID } from 'node:crypto';

import {
  SLEEP_HOURS_MAX,
  SLEEP_HOURS_MIN,
  WELLNESS_SCALE_MAX,
  WELLNESS_SCALE_MIN,
} from '@/src/shared/wellnessScales';

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
}): Promise<{ row: AthleteCheckInRow; created: boolean } | null> {
  const athlete = await queryOne<{ athlete_id: string }>(
    `select athlete_id from pilot.athletes
     where organization_id = $1 and athlete_id = $2`,
    [input.organizationId, input.athleteId],
  );
  if (!athlete) return null;

  const existing = await getTodayCheckIn(input.organizationId, input.athleteId);
  if (existing) return { row: existing, created: false };

  const checkInId = randomUUID();
  await queryOne(
    `insert into pilot.athlete_check_ins
       (organization_id, check_in_id, athlete_id,
        energy, soreness, focus, sleep_hours, hydration, motivation,
        mental_clarity, stress, nutrition_compliance, note)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (organization_id, athlete_id, checked_in_on) do nothing
     returning check_in_id`,
    [
      input.organizationId,
      checkInId,
      input.athleteId,
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
  const row = await getTodayCheckIn(input.organizationId, input.athleteId);
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

export async function getTodayCheckIn(organizationId: string, athleteId: string): Promise<AthleteCheckInRow | null> {
  return queryOne<AthleteCheckInRow>(
    `select ${CHECK_IN_COLUMNS}
     from pilot.athlete_check_ins
     where organization_id = $1 and athlete_id = $2 and checked_in_on = current_date`,
    [organizationId, athleteId],
  );
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
