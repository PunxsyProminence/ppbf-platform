import { randomUUID } from 'node:crypto';

import { query, queryOne } from './db';

// Athlete self check-in (Phase 2 slice 1): the athlete's own "I'm here,
// and this is how I feel" -- one row per athlete per day. Deliberately NOT
// attendance (that stays the coach/terminal register the passbook counts)
// and NOT pilot.readiness (formula scores; the readiness board reads that
// table unfiltered, so self-reports there would contaminate it).
//
// Wellness self-reports (energy / soreness / focus, 1-5) are optional --
// skipping them is legal and stored as null, never defaulted.

export interface AthleteCheckInRow {
  organization_id: string;
  check_in_id: string;
  athlete_id: string;
  checked_in_on: string;
  energy: number | null;
  soreness: number | null;
  focus: number | null;
  note: string;
  created_at: string;
}

/** Returns the reason a wellness value is refused, or null. Absence is
 * legal; a present value must be an integer 1-5. */
export function wellnessValueError(name: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
    return `${name} must be a whole number from 1 to 5, or omitted.`;
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
       (organization_id, check_in_id, athlete_id, energy, soreness, focus, note)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (organization_id, athlete_id, checked_in_on) do nothing
     returning check_in_id`,
    [
      input.organizationId,
      checkInId,
      input.athleteId,
      input.energy ?? null,
      input.soreness ?? null,
      input.focus ?? null,
      input.note ?? '',
    ],
  );

  // Under a concurrent double-tap the conflict clause makes one insert win;
  // both callers read back the same day's row.
  const row = await getTodayCheckIn(input.organizationId, input.athleteId);
  if (!row) return null;
  return { row, created: row.check_in_id === checkInId };
}

export async function getTodayCheckIn(organizationId: string, athleteId: string): Promise<AthleteCheckInRow | null> {
  return queryOne<AthleteCheckInRow>(
    `select organization_id, check_in_id, athlete_id, checked_in_on::text as checked_in_on,
            energy, soreness, focus, note, created_at
     from pilot.athlete_check_ins
     where organization_id = $1 and athlete_id = $2 and checked_in_on = current_date`,
    [organizationId, athleteId],
  );
}

/** The athlete's own recent history, newest first. One athlete at a time,
 * their own record -- there is no cross-athlete read here. */
export async function listRecentCheckIns(organizationId: string, athleteId: string, limit = 14): Promise<AthleteCheckInRow[]> {
  return query<AthleteCheckInRow>(
    `select organization_id, check_in_id, athlete_id, checked_in_on::text as checked_in_on,
            energy, soreness, focus, note, created_at
     from pilot.athlete_check_ins
     where organization_id = $1 and athlete_id = $2
     order by checked_in_on desc
     limit $3`,
    [organizationId, athleteId, limit],
  );
}
