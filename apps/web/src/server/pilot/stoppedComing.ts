/**
 * WHO HAS STOPPED COMING (lane W4-6, SC-1; W4 item 6, app scrub CF-14).
 *
 * The gym's active athletes who have come before and have not come for the
 * gym's number of days (stoppedComingPolicy.ts). For a coach and the gym admin,
 * on the stopped-coming page only.
 *
 * WHO IS LISTED, by ruling:
 *   - Active members seen at least once (OW27-31 A, OD-2026-11-21-006): a live
 *     athlete of this gym who is not marked as left the gym
 *     (pilot.athletes.active_flag; Overwatch, W4-6 Q3: the card's own words,
 *     "Skips people who signed up and never came, or have left"), and who has
 *     come at least once.
 *   - "Came" (OW27-32 A, "Yes, on this page only"; Overwatch, W4-6 Q2 A): a
 *     present day in the class register (pilot.attendance_reconciled, through
 *     getAttendanceLast28Days, whose last present day is not limited to 28
 *     days) OR a standing "here" mark on an UNTIED, open-gym session run
 *     (pilot.session_run_athletes, removed_at null; session_script_runs.class_id
 *     null). A tied run's tap already wrote the register, and a later register
 *     change wins there (docs/current/ATTENDANCE_PRECEDENCE.md), so tied runs
 *     are left to the register. The later of the two is the last day they came.
 *   - Listed when today minus that day is the gym's number of days or more: no
 *     day they came among the last N gym days, today included.
 *
 * ON THIS PAGE ONLY. The two reads are made apart and combined here. Nothing
 * here writes, and no attendance figure, report, board or grant figure reads
 * this (OW27-32 A: "OD-2026-09-28-008 and CT-13 stand"). The answer's words are
 * "came", not "present" or "attendance", for the same reason.
 *
 * WHO MAY READ: a coach or the gym admin with an ACTIVE staff membership in
 * this gym (staffNoteRoleInOrganization, the rule a session mark is written
 * and read under). Anyone else is refused with 403, never handed an empty list:
 * an empty list here reads as "nobody has stopped coming". A coach's reach is
 * the whole gym (access.ts), so a coach and the gym admin see the same list.
 * sessionRunPresenceStaffOnly.convention.test.ts pins this module and its one
 * route as readers of the staff-only presence record (Overwatch, W4-6 GO,
 * condition 1).
 *
 * What leaves this module: athlete id, name, the last day they came and the
 * days since. No date of birth, membership, mark, run or count.
 */

import { GYM_TIME_ZONE } from '../../lib/gymTime';

import type { ActorIdentity } from './access';
import { getAttendanceLast28Days } from './attendancePrecedence';
import { organizationActionableRoster } from './coachAthleteRoster';
import { query } from './db';
import { ForbiddenError } from './errors';
import { staffNoteRoleInOrganization } from './sessionStaffNotes';
import { readStoppedComingPolicy, type StoppedComingGapDays } from './stoppedComingPolicy';

export interface StoppedComingAthlete {
  readonly athlete_id: string;
  readonly full_name: string;
  /** The gym-local day they last came (register present day or open-gym here mark). */
  readonly last_came_day: string;
  /** Whole days from last_came_day to today; at least gap_days. */
  readonly days_since_came: number;
}

export interface StoppedComingList {
  readonly gap_days: StoppedComingGapDays;
  readonly is_default: boolean;
  /** The gym-local day the list was read for. */
  readonly today: string;
  /** Longest gone first; names break ties. */
  readonly athletes: readonly StoppedComingAthlete[];
}

function dayNumber(isoDay: string): number {
  return Math.round(Date.parse(`${isoDay}T00:00:00Z`) / 86_400_000);
}

/**
 * The gym-local day of each athlete's last standing "here" mark on an untied
 * (open-gym) run, up to today. Athletes with none have no row.
 */
async function lastOpenGymDays(
  organizationId: string,
  athleteIds: readonly string[],
  today: string,
): Promise<Map<string, string>> {
  if (athleteIds.length === 0) return new Map();
  const rows = await query<{ athlete_id: string; last_day: string }>(
    `select m.athlete_id, max((m.marked_at at time zone $4)::date)::text as last_day
       from pilot.session_run_athletes m
       join pilot.session_script_runs r
         on r.organization_id = m.organization_id and r.run_id = m.run_id
      where m.organization_id = $1
        and m.athlete_id = any($2::text[])
        and m.removed_at is null
        and r.class_id is null
        and (m.marked_at at time zone $4)::date <= $3::date
      group by m.athlete_id`,
    [organizationId, [...athleteIds], today, GYM_TIME_ZONE],
  );
  return new Map(rows.map((row) => [row.athlete_id, row.last_day]));
}

/** `today` is the gym-local day (gymDayIso), passed in so tests are fixed. */
export async function listStoppedComing(actor: ActorIdentity, today: string): Promise<StoppedComingList> {
  if (!(await staffNoteRoleInOrganization(actor))) {
    throw new ForbiddenError('Forbidden: only a coach or the gym admin of this gym reads who has stopped coming');
  }
  const organizationId = actor.organizationId;
  const policy = await readStoppedComingPolicy(organizationId);
  const active = (await organizationActionableRoster(organizationId)).filter((athlete) => athlete.active_flag === true);
  const ids = active.map((athlete) => athlete.athlete_id);

  const [register, openGym] = await Promise.all([
    getAttendanceLast28Days(organizationId, ids, today),
    lastOpenGymDays(organizationId, ids, today),
  ]);

  const todayNumber = dayNumber(today);
  const athletes: StoppedComingAthlete[] = [];
  for (const athlete of active) {
    const registerDay = register.get(athlete.athlete_id)?.last_present_day ?? null;
    const openGymDay = openGym.get(athlete.athlete_id) ?? null;
    // ISO days compare as text. Neither: never came, so not listed (OW27-31 A).
    const lastCame = registerDay !== null && openGymDay !== null
      ? (registerDay > openGymDay ? registerDay : openGymDay)
      : (registerDay ?? openGymDay);
    if (lastCame === null) continue;
    const daysSince = todayNumber - dayNumber(lastCame);
    if (daysSince < policy.gap_days) continue;
    athletes.push({
      athlete_id: athlete.athlete_id,
      full_name: athlete.full_name,
      last_came_day: lastCame,
      days_since_came: daysSince,
    });
  }
  athletes.sort((a, b) =>
    b.days_since_came - a.days_since_came
    || a.full_name.localeCompare(b.full_name)
    || a.athlete_id.localeCompare(b.athlete_id));

  return { gap_days: policy.gap_days, is_default: policy.is_default, today, athletes };
}
