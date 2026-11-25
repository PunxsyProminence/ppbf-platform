/**
 * WHO HAS STOPPED COMING (lane W4-6, SC-1; W4 item 6, app scrub CF-14).
 *
 * The gym's active athletes who have come before and have not come for the
 * gym's number of days (stoppedComingPolicy.ts). For a coach and the gym admin,
 * on the stopped-coming page only.
 *
 * WHO IS LISTED, by ruling:
 *   - Active members seen at least once (OW27-31 A, OD-2026-11-21-006: "Active
 *     membership and present at least once before"): a live athlete of this gym
 *     who is not marked as left the gym (pilot.athletes.active_flag) AND, when
 *     the gym records program memberships for that athlete, holds at least one
 *     that is active; lapsed or ended only means not listed. An athlete with no
 *     program membership recorded is decided by active_flag alone, so a gym that
 *     does not use memberships still gets a list (Overwatch on #2172, correcting
 *     its W4-6 Q3 answer). And who has come at least once.
 *   - "Came" (OW27-32 A, "Yes, on this page only"; Overwatch, W4-6 Q2 A and
 *     the answer on #2172): a present day in the class register
 *     (pilot.attendance_reconciled, through getAttendanceLast28Days, whose last
 *     present day is not limited to 28 days) OR a standing "here" mark
 *     (pilot.session_run_athletes, removed_at null) that the register does not
 *     hold: its run is untied (open gym; session_script_runs.class_id null), or
 *     the tap created no register mark (register_written_at null; only a tap
 *     that creates the mark sets it, sessionRunClass.ts: the write was skipped
 *     because the class was cancelled or another coach had its cover, or the
 *     register already said Present, or the tap turned an Absent or Excused
 *     into Present, or the session was tied later over a newer register mark),
 *     or the class it was written to is cancelled (the view reads no cancelled
 *     class). A tap whose register mark it created and which still stands
 *     defers to the register, so a later Absent there wins
 *     (docs/current/ATTENDANCE_PRECEDENCE.md). The later of the two sources is
 *     the last day they came.
 *     STILL AS RULED, NOTED: the tie is read as it is now, so a run untied after
 *     a tap counts that tap as open gym; and a tap that created no register
 *     mark counts here even when that day's register is (or is later set to)
 *     Absent.
 *   - Listed when today minus that day is the gym's number of days or more: no
 *     day they came among the last N gym days, today included.
 *
 * ON THIS PAGE ONLY. The two reads are made apart and combined here. No
 * attendance figure, report, board or grant figure reads this (OW27-32 A:
 * "OD-2026-09-28-008 and CT-13 stand"). The answer's words are "came", not
 * "present" or "attendance", for the same reason.
 *
 * THE "REACHED OUT" MARK (SC-3a-2; OW27-33 B, Overwatch W4-6 Q4 A), the one
 * write here: setStoppedComingReachedOut, through reachedOutMarks.ts. It is
 * here so the presence record keeps exactly two readers (Overwatch on #2163,
 * answer A); the athlete's last day they came is read from both sources on the
 * write's transaction. A mark shows, and can be taken back, only while newer
 * than that day; a stale one is replaced by a new mark.
 *
 * WHO MAY READ AND MARK: a coach or the gym admin with an ACTIVE staff
 * membership in this gym (staffNoteRoleInOrganization, the rule a session mark
 * is written and read under). Anyone else is refused with 403, never handed an
 * empty list: an empty list here reads as "nobody has stopped coming". A
 * coach's reach is the whole gym (access.ts), so a coach and the gym admin see
 * the same list. A mark is for a live athlete of this gym (404) who is on the
 * list now, by its own rules (409; the day rule read on the write's
 * transaction); membership and athlete are checked again under lock in the
 * write, as sessionRunAthletes.ts does.
 * sessionRunPresenceStaffOnly.convention.test.ts pins this module and its one
 * route as readers of the staff-only presence record (Overwatch, W4-6 GO,
 * condition 1).
 *
 * What leaves this module: athlete id, name, the last day they came, the days
 * since, and the reached-out mark as who (display name) and the gym day, or
 * null; a mark write answers one outcome word. No date of birth, membership,
 * here mark, run, count or account id. Membership records stay admin-only
 * (programMemberships.ts): the one membership read returns ids to leave off,
 * and no status, program or date leaves it.
 */

import type { PoolClient } from 'pg';

import { GYM_TIME_ZONE } from '../../lib/gymTime';

import type { ActorIdentity } from './access';
import { getAttendanceLast28Days } from './attendancePrecedence';
import { organizationActionableRoster } from './coachAthleteRoster';
import { query, withTransaction } from './db';
import { ConflictError, ForbiddenError, NotFoundError } from './errors';
import { type ReachedOut, type ReachedOutOutcome, readCurrentReachedOut, setReachedOutMark } from './reachedOutMarks';
import { lockLiveAthlete, lockStaffMembership, staffNoteRoleInOrganization } from './sessionStaffNotes';
import { readStoppedComingPolicy, type StoppedComingGapDays } from './stoppedComingPolicy';

export interface StoppedComingAthlete {
  readonly athlete_id: string;
  readonly full_name: string;
  /** The gym-local day they last came (a register present day, or a here mark the register does not hold). */
  readonly last_came_day: string;
  /** Whole days from last_came_day to today; at least gap_days. */
  readonly days_since_came: number;
  /** Who reached out and on which gym day, while that mark is newer than last_came_day; else null. */
  readonly reached_out: ReachedOut | null;
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

/** Listed by the day rule: came at least once, and not for the gym's number of days, today included. */
function goneLongEnough(lastCame: string | null, today: string, gapDays: number): lastCame is string {
  return lastCame !== null && dayNumber(today) - dayNumber(lastCame) >= gapDays;
}

/** The later of the two sources' days (ISO days compare as text); null when neither: never came. */
function laterDay(registerDay: string | null, openGymDay: string | null): string | null {
  return registerDay !== null && openGymDay !== null
    ? (registerDay > openGymDay ? registerDay : openGymDay)
    : (registerDay ?? openGymDay);
}

/**
 * Of these athletes, those the gym records program memberships for, none of
 * them active (lapsed or ended only): they are not listed. An athlete with no
 * membership row in this gym is not returned. Ids only.
 */
async function athletesWithNoActiveMembership(
  organizationId: string,
  athleteIds: readonly string[],
): Promise<Set<string>> {
  if (athleteIds.length === 0) return new Set();
  const rows = await query<{ athlete_id: string }>(
    `select pm.athlete_id
       from pilot.program_memberships pm
      where pm.organization_id = $1
        and pm.athlete_id = any($2::text[])
      group by pm.athlete_id
     having not bool_or(pm.status = 'active')`,
    [organizationId, [...athleteIds]],
  );
  return new Set(rows.map((row) => row.athlete_id));
}

/**
 * The gym-local day of each athlete's last standing "here" mark that the
 * register does not hold (see the header), up to today. Athletes with none
 * have no row. `client` runs it on the caller's transaction (a mark write).
 */
async function lastOpenGymDays(
  organizationId: string,
  athleteIds: readonly string[],
  today: string,
  client?: PoolClient,
): Promise<Map<string, string>> {
  if (athleteIds.length === 0) return new Map();
  type Row = { athlete_id: string; last_day: string };
  const read = async (text: string, params: unknown[]): Promise<Row[]> =>
    (client ? (await client.query<Row>(text, params)).rows : query<Row>(text, params));
  const rows = await read(
    `select m.athlete_id, max((m.marked_at at time zone $4)::date)::text as last_day
       from pilot.session_run_athletes m
       join pilot.session_script_runs r
         on r.organization_id = m.organization_id and r.run_id = m.run_id
       left join pilot.scheduler_classes c
         on c.organization_id = m.organization_id and c.class_id = m.register_class_id
      where m.organization_id = $1
        and m.athlete_id = any($2::text[])
        and m.removed_at is null
        and (r.class_id is null or m.register_written_at is null or c.status = 'cancelled')
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
  const notLeft = (await organizationActionableRoster(organizationId)).filter((athlete) => athlete.active_flag === true);
  const noActiveMembership = await athletesWithNoActiveMembership(
    organizationId,
    notLeft.map((athlete) => athlete.athlete_id),
  );
  const active = notLeft.filter((athlete) => !noActiveMembership.has(athlete.athlete_id));
  const ids = active.map((athlete) => athlete.athlete_id);

  const [register, openGym] = await Promise.all([
    getAttendanceLast28Days(organizationId, ids, today),
    lastOpenGymDays(organizationId, ids, today),
  ]);

  const todayNumber = dayNumber(today);
  const athletes: StoppedComingAthlete[] = [];
  for (const athlete of active) {
    // Neither source: never came, so not listed (OW27-31 A).
    const lastCame = laterDay(
      register.get(athlete.athlete_id)?.last_present_day ?? null,
      openGym.get(athlete.athlete_id) ?? null,
    );
    if (!goneLongEnough(lastCame, today, policy.gap_days)) continue;
    const daysSince = todayNumber - dayNumber(lastCame);
    athletes.push({
      athlete_id: athlete.athlete_id,
      full_name: athlete.full_name,
      last_came_day: lastCame,
      days_since_came: daysSince,
      reached_out: null,
    });
  }
  athletes.sort((a, b) =>
    b.days_since_came - a.days_since_came
    || a.full_name.localeCompare(b.full_name)
    || a.athlete_id.localeCompare(b.athlete_id));

  // The listed athletes' current marks, each only while newer than their last day they came.
  const reachedOut = await readCurrentReachedOut(
    organizationId,
    new Map(athletes.map((athlete) => [athlete.athlete_id, athlete.last_came_day])),
  );
  return {
    gap_days: policy.gap_days,
    is_default: policy.is_default,
    today,
    athletes: athletes.map((athlete) => ({ ...athlete, reached_out: reachedOut.get(athlete.athlete_id) ?? null })),
  };
}

const NOT_STAFF_TO_MARK = 'Forbidden: only a coach or the gym admin of this gym marks who was reached out to';

const NOT_LISTED = 'This athlete is not on the stopped-coming list now. Reload the page.';

/**
 * Marks that the actor reached out to one athlete (`reachedOut` true), or
 * takes the mark back (false). The athlete must be a live athlete of this gym
 * (404), and a mark is only for one on the list now, by the list's own rules
 * (not left, an active membership where any is recorded, came at least once,
 * gone the gym's number of days; 409 otherwise, nothing written): a mark the
 * page would never show is not written. A take-back needs no list check.
 * `today` is the gym-local day (gymDayIso), passed in so tests are fixed.
 */
export async function setStoppedComingReachedOut(
  actor: ActorIdentity,
  athleteId: string,
  reachedOut: boolean,
  today: string,
): Promise<ReachedOutOutcome> {
  if (!(await staffNoteRoleInOrganization(actor))) {
    throw new ForbiddenError(NOT_STAFF_TO_MARK);
  }
  const organizationId = actor.organizationId;
  // Live athletes of this gym only: the table would take a soft-deleted one. 404, as athleteInjuries.ts answers.
  const athlete = (await organizationActionableRoster(organizationId)).find((row) => row.athlete_id === athleteId);
  if (!athlete) throw new NotFoundError('Athlete not found.');
  const policy = reachedOut ? await readStoppedComingPolicy(organizationId) : null;
  if (reachedOut && (athlete.active_flag !== true
    || (await athletesWithNoActiveMembership(organizationId, [athleteId])).has(athleteId))) {
    throw new ConflictError(NOT_LISTED, 'NOT_ON_STOPPED_COMING_LIST');
  }
  return withTransaction(async (client) => {
    // Both again, under lock, as sessionRunAthletes.ts marks a session: membership and account,
    // then the athlete row, then (in reachedOutMarks.ts) the mark row. The role is the membership's.
    const role = await lockStaffMembership(client, actor);
    if (!role) throw new ForbiddenError(NOT_STAFF_TO_MARK);
    if (!(await lockLiveAthlete(client, organizationId, athleteId))) throw new NotFoundError('Athlete not found.');
    // The last day they came, from both sources, on this transaction (Overwatch on #2163, answer A).
    const register = await getAttendanceLast28Days(organizationId, [athleteId], today, client);
    const openGym = await lastOpenGymDays(organizationId, [athleteId], today, client);
    const lastCameDay = laterDay(register.get(athleteId)?.last_present_day ?? null, openGym.get(athleteId) ?? null);
    if (policy && !goneLongEnough(lastCameDay, today, policy.gap_days)) {
      throw new ConflictError(NOT_LISTED, 'NOT_ON_STOPPED_COMING_LIST');
    }
    return setReachedOutMark(client, { actor, role, athleteId, lastCameDay, reachedOut });
  });
}
