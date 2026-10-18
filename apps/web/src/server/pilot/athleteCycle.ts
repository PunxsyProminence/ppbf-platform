import { randomUUID } from 'node:crypto';

import { gymDayIso, type GymTimeInput } from '../../lib/gymTime';

import { query, queryOne } from './db';

// CYCLE TRACKING (OD-2026-10-17-023 item 4, Jason: "C: Now"). A child's health
// data, so this module holds the rule the tables were built for
// (pilot_slice_postgres_athlete_self_report_measures_migration.sql, section 6):
//
//   * OPT-IN by the athlete: nothing is stored until they turn it on, and an
//     entry cannot exist without the opt-in row (its foreign key).
//   * ATHLETE ONLY: this module is imported only by the athlete's own route
//     (app/api/pilot/athlete/cycle/), every statement is bound to the athlete
//     id the route takes from the athlete's own session, and
//     cycleTrackingAthleteOnly.test.ts fails if any other code names the
//     tables or imports this module. No coach, parent, staff, gym TV, SHADOW,
//     export or research path reads it.
//   * NO AUDIT ROW (Overwatch-approved): an audit row would itself tell an
//     admin reading the audit log that a child logged a period.
//   * NEVER CHANGES TRAINING: nothing here is read by any plan, limit, load or
//     baseline computation. Dates only; nothing derived (no length, phase or
//     prediction).
//   * DELETED WITH THE ATHLETE (cascade), and by the athlete at any time:
//     Remove takes one date away; turning tracking off deletes every date.

export interface CycleEntry {
  entry_id: string;
  period_started_on: string;
}

export interface CycleTracking {
  optedIn: boolean;
  entries: CycleEntry[];
}

/** How many past dates the athlete's screen lists. */
export const CYCLE_ENTRIES_SHOWN = 24;

async function athleteIsLive(organizationId: string, athleteId: string): Promise<boolean> {
  const row = await queryOne<{ live: boolean }>(
    `select true as live from pilot.athletes where organization_id = $1 and athlete_id = $2 and deleted_at is null`,
    [organizationId, athleteId],
  );
  return row?.live === true;
}

export async function getCycleTracking(organizationId: string, athleteId: string): Promise<CycleTracking> {
  const tracking = await queryOne<{ opted_in: boolean }>(
    `select true as opted_in from pilot.athlete_cycle_tracking where organization_id = $1 and athlete_id = $2`,
    [organizationId, athleteId],
  );
  if (!tracking) return { optedIn: false, entries: [] };
  const entries = await query<CycleEntry>(
    `select entry_id, period_started_on::text as period_started_on
     from pilot.athlete_cycle_entries
     where organization_id = $1 and athlete_id = $2
     order by period_started_on desc
     limit $3`,
    [organizationId, athleteId, CYCLE_ENTRIES_SHOWN],
  );
  return { optedIn: true, entries };
}

export async function turnOnCycleTracking(organizationId: string, athleteId: string): Promise<boolean> {
  if (!(await athleteIsLive(organizationId, athleteId))) return false;
  await query(
    `insert into pilot.athlete_cycle_tracking (organization_id, athlete_id) values ($1, $2)
     on conflict (organization_id, athlete_id) do nothing`,
    [organizationId, athleteId],
  );
  return true;
}

/** Turning it off deletes every date with it (the entries' foreign key cascades). */
export async function turnOffCycleTracking(organizationId: string, athleteId: string): Promise<void> {
  await query(
    `delete from pilot.athlete_cycle_tracking where organization_id = $1 and athlete_id = $2`,
    [organizationId, athleteId],
  );
}

/** Why a day is refused, or null. A day is a calendar date no later than the
 * gym's today. */
export function cycleDayError(day: unknown, now: GymTimeInput = new Date()): string | null {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return 'day must be a date (YYYY-MM-DD).';
  const parsed = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) return 'day must be a real date.';
  const today = gymDayIso(now);
  if (today && day > today) return 'day cannot be after today.';
  return null;
}

/**
 * Logs the day a period started (the gym's today when no day is given). One
 * per day: logging the same day again is the same entry. Returns 'off' when
 * tracking is not on -- the athlete turns it on first -- and null when the
 * athlete record is not live.
 */
export async function addCycleEntry(
  organizationId: string,
  athleteId: string,
  day: string | undefined,
  now: GymTimeInput = new Date(),
): Promise<CycleEntry | 'off' | null> {
  if (!(await athleteIsLive(organizationId, athleteId))) return null;
  const tracking = await getCycleTracking(organizationId, athleteId);
  if (!tracking.optedIn) return 'off';
  const startedOn = day ?? gymDayIso(now);
  if (!startedOn) throw new Error('CYCLE_GYM_DAY_UNRESOLVED');
  await query(
    `insert into pilot.athlete_cycle_entries (organization_id, entry_id, athlete_id, period_started_on)
     values ($1, $2, $3, $4::date)
     on conflict (organization_id, athlete_id, period_started_on) do nothing`,
    [organizationId, randomUUID(), athleteId, startedOn],
  );
  return queryOne<CycleEntry>(
    `select entry_id, period_started_on::text as period_started_on from pilot.athlete_cycle_entries
     where organization_id = $1 and athlete_id = $2 and period_started_on = $3::date`,
    [organizationId, athleteId, startedOn],
  );
}

/** Removes one of the athlete's own dates. Another athlete's entry id matches nothing. */
export async function removeCycleEntry(organizationId: string, athleteId: string, entryId: string): Promise<boolean> {
  const removed = await query<{ entry_id: string }>(
    `delete from pilot.athlete_cycle_entries
     where organization_id = $1 and athlete_id = $2 and entry_id = $3
     returning entry_id`,
    [organizationId, athleteId, entryId],
  );
  return removed.length > 0;
}
