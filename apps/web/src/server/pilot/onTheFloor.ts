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
 *     this staff line (FN0-Q1 A, App Overwatch on #2160) and are left off a
 *     family's line (FN0-Q1 A; FN-0 flag 9, decided at sign-off).
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
 * WHO MAY READ, AND WHAT EACH IS GIVEN.
 *   - listOnTheFloorForStaff: a coach or the gym admin with an ACTIVE staff
 *     membership in this gym (staffNoteRoleInOrganization, the rule a mark is
 *     written and read under). It returns the gym day, and each counted
 *     athlete's id and name, in name order (Q3.3 A).
 *   - onTheFloorForFamily (lane W4-3, FN-2; OD-2026-11-21-006, Q3.2 A and
 *     Q3.4 A): a parent is given the ids of their own children who count; the
 *     children are guardianAthleteIds', the guardian rule with its 18 and
 *     deletion rules inside it, never the request's (FN-0 F6). An athlete is
 *     given yes or no about themselves only. FN-0 F1: this is the one way a
 *     fact derived from the staff-only presence record reaches a family, and it
 *     is that yes or no and nothing else.
 *   Anyone else is refused with 403, never handed an empty answer: an empty
 *   staff list reads as "Nobody is counted on the floor right now."
 *   sessionRunPresenceStaffOnly.convention.test.ts pins this module and its one
 *   route as readers of the presence record.
 *
 * No source, run, class, coach, method, mark time or count leaves this module,
 * to anyone. The organization and the athlete ids come from the actor and the
 * server's own records, never from a request.
 */

import { GYM_TIME_ZONE, gymDayIso } from '../../lib/gymTime';

import type { ActorIdentity } from './access';
import { organizationActionableRoster } from './coachAthleteRoster';
import { query } from './db';
import { ForbiddenError } from './errors';
import { guardianAthleteIds } from './guardianAccess';
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

/** A parent's own children who count, by id; or an athlete's yes or no about themselves. */
export type OnTheFloorFamilyAnswer =
  | { readonly reader: 'parent'; readonly on_the_floor: readonly string[] }
  | { readonly reader: 'athlete'; readonly on_the_floor: boolean };

/**
 * Athletes with a standing mark on a live run, less those a later Absent or Excused took off. Ids only.
 * For a family, a run tied to a cancelled class is left out too (flag 9).
 */
async function markedOnLiveRuns(organizationId: string, athleteIds: readonly string[], forFamily: boolean): Promise<string[]> {
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
        )
        and not (
          $3::boolean
          and exists (
            select 1
              from pilot.scheduler_classes cancelled
             where cancelled.organization_id = r.organization_id
               and cancelled.class_id = r.class_id
               and cancelled.status = 'cancelled'
          )
        )`,
    [organizationId, [...athleteIds], forFamily],
  );
  return rows.map((row) => row.athlete_id);
}

/**
 * Athletes with a present register mark that counts now, on a class whose gym day is today. Ids only.
 * For a family, a cancelled class's marks are left out (FN0-Q1 A).
 */
async function presentOnTodaysRegister(
  organizationId: string,
  athleteIds: readonly string[],
  day: string,
  now: Date,
  forFamily: boolean,
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
        )
        and not ($6::boolean and c.status = 'cancelled')`,
    [organizationId, [...athleteIds], GYM_TIME_ZONE, day, now.toISOString(), forFamily],
  );
  return rows.map((row) => row.athlete_id);
}

/**
 * Which of these athletes count now, by either source. The two reads run together and either failing
 * fails the whole read (F15).
 */
async function countedAmong(
  organizationId: string,
  athleteIds: readonly string[],
  day: string,
  now: Date,
  forFamily: boolean,
): Promise<Set<string>> {
  const [fromRuns, fromRegister] = await Promise.all([
    markedOnLiveRuns(organizationId, athleteIds, forFamily),
    presentOnTodaysRegister(organizationId, athleteIds, day, now, forFamily),
  ]);
  return new Set([...fromRuns, ...fromRegister]);
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
  const counted = await countedAmong(organizationId, ids, day, now, false);

  const athletes = roster
    .filter((athlete) => counted.has(athlete.athlete_id))
    .map(({ athlete_id, full_name }) => ({ athlete_id, full_name }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name) || a.athlete_id.localeCompare(b.athlete_id));
  return { day, athletes };
}

/**
 * The family line (lane W4-3, FN-2). A parent is given the ids of their own children who count; an athlete,
 * yes or no about themselves. The same two reads as the staff line, less a cancelled class's marks and a run
 * tied to one (FN0-Q1 A; flag 9). `now` is the current moment, as for the staff read: it drives the idle close.
 */
export async function onTheFloorForFamily(actor: ActorIdentity, now: Date): Promise<OnTheFloorFamilyAnswer> {
  if (actor.role !== 'parent' && !(actor.role === 'athlete' && actor.athleteId)) {
    throw new ForbiddenError('Forbidden: only a parent, or an athlete linked to their record, reads this line');
  }
  const organizationId = actor.organizationId;
  // The scope is the server's, never the request's: the guardian rule for a parent (FN-0 F6), the
  // account's own record for an athlete.
  const scope = actor.role === 'parent' ? await guardianAthleteIds(organizationId, actor.accountId) : [actor.athleteId as string];
  // An empty scope matches nothing, never the gym (FN-0 check 1); and nothing is read or settled for it.
  if (scope.length === 0) return { reader: 'parent', on_the_floor: [] };

  const day = gymDayIso(now);
  if (!day) throw new Error('ON_THE_FLOOR_DAY_UNRESOLVED');
  await closeIdleSessionRuns(organizationId, { now });

  const live = new Set((await organizationActionableRoster(organizationId)).map((athlete) => athlete.athlete_id));
  const ids = scope.filter((id) => live.has(id));
  const counted = await countedAmong(organizationId, ids, day, now, true);
  if (actor.role === 'athlete') return { reader: 'athlete', on_the_floor: ids.length === 1 && counted.has(ids[0]) };
  return { reader: 'parent', on_the_floor: ids.filter((id) => counted.has(id)) };
}
