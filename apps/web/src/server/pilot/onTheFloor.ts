/**
 * WHO IS ON THE FLOOR NOW (lane W4-3, FN-1; W4 item 3). The staff read behind
 * the coach and admin line, "On the floor now: [names]". Plan #2192, GO
 * 7164371671; privacy review FN-0 (docs/content-review/w4-sizing/
 * FN-0_FLOOR_LINE_PRIVACY_REVIEW.md), signed off on #2160.
 *
 * WHO COUNTS, by ruling (Jason's Q3.1 C, "Either one", OD-2026-11-21-006):
 *   - A standing "here" mark (pilot.session_run_athletes, removed_at null) on
 *     a run of this gym that is in progress. Idle runs are settled first (see
 *     below), so a forgotten run never shows as live (F13).
 *     On a run tied to a class, a later Absent or Excused on that class's
 *     register takes the child off the line, for every reader (FN0-Q6 A).
 *     "Later" is the register's own test for "a later register change still
 *     wins": the register row was updated after the mark (schedulerDb.ts,
 *     writeSessionRegisterPresent). It applies to that run's mark, as FN-0
 *     section 4 frames it ("except as FN0-Q6 rules for a run tied to a class
 *     ..."), and reads the run's tie as it is now: a child still counts by
 *     another standing mark or a present register mark of their own.
 *   - OR a present mark on the register of a class whose gym day is today.
 *     A mark the family wrote (the scheduler's own test, as
 *     FAMILY_ATTENDANCE_UPSERT_SQL has it: method self or parent, or an older
 *     parent mark by its role) counts from its class's start; a staff mark
 *     (coach, admin, walk-in) from when it is written; both to the end of
 *     that gym day (FN0-Q2 A).
 *   - A cancelled class's marks, and a run tied to a cancelled class, stay on
 *     this staff line (FN0-Q1 A, App Overwatch on #2160).
 * Never: a deleted athlete (the roster below), another gym's athlete or run, a
 * mark taken back, a settled run, an absent or excused register mark, a
 * register mark on another day's class. No other record is read: not the
 * reconciled attendance view, the activity log, the legacy attendance table or
 * a wellness check-in (F9; the convention test pins that this file names none).
 * THIS IS NOT ATTENDANCE (the OW27-19 card; CT-13): no attendance figure,
 * report, board or grant figure reads it.
 *
 * THE IDLE CLOSE. closeIdleSessionRuns settles every run of this gym idle past
 * the 3-hour limit (OD-2026-10-21-001 D2) before anything is read, and it
 * THROWS on a failure, unlike sweepIdleRuns, which swallows one. So a stale
 * run is settled or the whole read fails: it never shows as live (F13;
 * accepted by name in the GO). It settles runs and closes their sampled
 * windows, as every other reader's sweep does, and writes no audit row.
 *
 * ONE ANSWER OR NONE. The two reads run together and either failing fails the
 * read, so a list built from one source never looks complete (F15).
 *
 * WHO MAY READ: a coach or the gym admin with an ACTIVE staff membership in
 * this gym (staffNoteRoleInOrganization, the rule a mark is written and read
 * under). Anyone else is refused with 403, never handed an empty list: an
 * empty list here reads as "Nobody is counted on the floor right now."
 * Parents and athletes are refused here until FN-2 opens their branches.
 * sessionRunPresenceStaffOnly.convention.test.ts pins this module and its one
 * route as readers of the staff-only presence record.
 *
 * What leaves this module: the gym day, and each counted athlete's id and
 * name, in name order. No source, run, class, coach, method, mark time or
 * count leaves it. The organization and the athlete ids come from the actor
 * and the server's own roster, never from a request.
 */

import { GYM_TIME_ZONE, gymDayIso } from '../../lib/gymTime';

import type { ActorIdentity } from './access';
import { organizationActionableRoster } from './coachAthleteRoster';
import { query } from './db';
import { ForbiddenError } from './errors';
import { closeIdleSessionRuns } from './sessionScriptRuns';
import { staffNoteRoleInOrganization } from './sessionStaffNotes';

export interface OnTheFloorAthlete {
  readonly athlete_id: string;
  readonly full_name: string;
}

export interface OnTheFloorStaffLine {
  /** The gym-local day the line was read for. */
  readonly day: string;
  /** Who is counted on the floor now, in name order. */
  readonly athletes: readonly OnTheFloorAthlete[];
}

/** Athletes with a standing mark on a live run, less those a later Absent or Excused took off. Ids only. */
async function markedOnLiveRuns(organizationId: string, athleteIds: readonly string[]): Promise<string[]> {
  if (athleteIds.length === 0) return [];
  const rows = await query<{ athlete_id: string }>(
    `select distinct m.athlete_id
       from pilot.session_run_athletes m
       join pilot.session_script_runs r
         on r.organization_id = m.organization_id and r.run_id = m.run_id
      where m.organization_id = $1
        and m.athlete_id = any($2::text[])
        and m.removed_at is null
        and r.run_state = 'in_progress'
        and not exists (
          select 1
            from pilot.scheduler_attendance later
           where later.organization_id = r.organization_id
             and later.class_id = r.class_id
             and later.athlete_id = m.athlete_id
             and later.status in ('absent', 'excused')
             and later.updated_at > m.marked_at
        )`,
    [organizationId, [...athleteIds]],
  );
  return rows.map((row) => row.athlete_id);
}

/** Athletes with a present register mark that counts now, on a class whose gym day is today. Ids only. */
async function presentOnTodaysRegister(
  organizationId: string,
  athleteIds: readonly string[],
  day: string,
  now: Date,
): Promise<string[]> {
  if (athleteIds.length === 0) return [];
  const rows = await query<{ athlete_id: string }>(
    `select distinct sa.athlete_id
       from pilot.scheduler_attendance sa
       join pilot.scheduler_classes c
         on c.organization_id = sa.organization_id and c.class_id = sa.class_id
      where sa.organization_id = $1
        and sa.athlete_id = any($2::text[])
        and sa.status = 'present'
        and (c.start_at at time zone $3)::date = $4::date
        and c.start_at between $5::timestamptz - interval '2 days' and $5::timestamptz + interval '2 days'
        and sa.checked_in_at <= $5::timestamptz
        and (
          not (sa.method in ('self', 'parent') or sa.checked_in_by_role in ('athlete', 'parent'))
          or c.start_at <= $5::timestamptz
        )`,
    [organizationId, [...athleteIds], GYM_TIME_ZONE, day, now.toISOString()],
  );
  return rows.map((row) => row.athlete_id);
}

/**
 * `now` is passed in so tests are fixed. It must be the current moment: it also drives the idle
 * close, which settles runs, so a later time would settle live runs early. Its one caller, the route,
 * passes `new Date()`, and sessionRunPresenceStaffOnly.convention.test.ts pins that.
 */
export async function listOnTheFloorForStaff(actor: ActorIdentity, now: Date): Promise<OnTheFloorStaffLine> {
  if (!(await staffNoteRoleInOrganization(actor))) {
    throw new ForbiddenError('Forbidden: only a coach or the gym admin of this gym reads who is on the floor');
  }
  const day = gymDayIso(now);
  if (!day) throw new Error('ON_THE_FLOOR_DAY_UNRESOLVED');
  const organizationId = actor.organizationId;

  await closeIdleSessionRuns(organizationId, { now });

  const roster = await organizationActionableRoster(organizationId);
  const ids = roster.map((athlete) => athlete.athlete_id);
  const [fromRuns, fromRegister] = await Promise.all([
    markedOnLiveRuns(organizationId, ids),
    presentOnTodaysRegister(organizationId, ids, day, now),
  ]);
  const counted = new Set([...fromRuns, ...fromRegister]);

  const athletes = roster
    .filter((athlete) => counted.has(athlete.athlete_id))
    .map(({ athlete_id, full_name }) => ({ athlete_id, full_name }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name) || a.athlete_id.localeCompare(b.athlete_id));
  return { day, athletes };
}
