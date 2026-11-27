import { GYM_TIME_ZONE, gymDayIso } from '../../lib/gymTime';

import { BOARD_MINIMUM_COHORT_SIZE } from './boardSummary';
import { query, queryOne } from './db';

/**
 * HOW MANY ARE HERE, FROM THE CLASS REGISTER ONLY (lane W4-3, FN-4a; GO on #2192, 7206014991).
 *
 * The count behind the "on the floor now" line on the board's, the platform owner's and the
 * staff-role and volunteer homes (FN0-Q3, Q12 A as App Overwatch applied it). It reads present
 * marks on pilot.scheduler_attendance and nothing else:
 *   - REGISTER ONLY (flag 12; QC A). No session-run mark, no run table, no idle close: a run mark
 *     "feeds NO attendance report, reconciled view, board or grant figure" (Overwatch's 10-13 note on
 *     the run-marks migration). floorCountNoRuns.convention.test.ts
 *     holds this file, and every platform route, to that.
 *   - THE LINE'S OWN RULE (QD A; FN0-Q2 A, OD-2026-11-25-002): a present mark on a class whose gym
 *     day is today; a mark the family wrote counts from the class's start, a staff mark from when it
 *     is written. The same test as onTheFloor.ts's register half, so every home counts a person the
 *     same way, but for one difference: a cancelled class's marks, which the coach and admin line
 *     keeps (FN0-Q1 A), are left out of these counts (flag 10).
 *   - LEFT OUT: a cancelled class (flag 10), a deleted athlete, another gym's marks.
 *
 * No name, initials or id leaves this module: a class comes back as its title, times and room, and
 * a count as a number.
 */

/** A class running now: not cancelled, started, not yet ended, on today's gym day (wallDisplay.ts sessionState). */
export interface ClassRunningNow {
  readonly title: string;
  readonly start_at: string;
  readonly end_at: string;
  readonly room: string;
  /** How many are here on this class, by the line's own rule. */
  readonly count: number;
}

/** The board's floor, held for a live count (flag 3): every count from 0 to 4 is suppressed. */
export type FlooredCount =
  | { readonly status: 'available'; readonly count: number }
  | { readonly status: 'insufficient_data'; readonly count: null };

interface ClassRow {
  title: string;
  start_at: Date | string;
  end_at: Date | string;
  location: string;
  count: number | string;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function today(now: Date): string {
  const day = gymDayIso(now);
  if (!day) throw new Error('FLOOR_COUNT_DAY_UNRESOLVED');
  return day;
}

// A present mark that counts now, by the line's own rule. `sa` is the register row and `c` its class.
// $now is the read's time, $tz the gym's zone, $day today's gym day.
function countedMarkSql(now: string, tz: string, day: string): string {
  return `sa.status = 'present'
        and (c.start_at at time zone ${tz})::date = ${day}::date
        and c.start_at between ${now}::timestamptz - interval '2 days' and ${now}::timestamptz + interval '2 days'
        and c.status <> 'cancelled'
        and sa.checked_in_at <= ${now}::timestamptz
        and (
          not (sa.method in ('self', 'parent') or sa.checked_in_by_role in ('athlete', 'parent'))
          or c.start_at <= ${now}::timestamptz
        )`;
}

/** The classes running now in one gym, each with how many are here on it, earliest first. */
export async function classesRunningNow(organizationId: string, now: Date): Promise<ClassRunningNow[]> {
  const rows = await query<ClassRow>(
    `select c.title, c.start_at, c.end_at, c.location,
            (select count(distinct sa.athlete_id)::int
               from pilot.scheduler_attendance sa
               join pilot.athletes a
                 on a.organization_id = sa.organization_id and a.athlete_id = sa.athlete_id
                and a.deleted_at is null
              where sa.organization_id = c.organization_id
                and sa.class_id = c.class_id
                and ${countedMarkSql('$2', '$3', '$4')}) as count
       from pilot.scheduler_classes c
      where c.organization_id = $1
        and c.status <> 'cancelled'
        and c.start_at between $2::timestamptz - interval '2 days' and $2::timestamptz
        and c.end_at > $2::timestamptz
        and (c.start_at at time zone $3)::date = $4::date
      order by c.start_at asc, c.title asc`,
    [organizationId, now.toISOString(), GYM_TIME_ZONE, today(now)],
  );
  return rows.map((row) => ({
    title: row.title,
    start_at: iso(row.start_at),
    end_at: iso(row.end_at),
    room: row.location,
    count: Number(row.count),
  }));
}

/** How many different athletes are here today in one gym, by the line's own rule. Exact: floor it before it reaches a board or platform reader. */
export async function registerTotalToday(organizationId: string, now: Date): Promise<number> {
  const row = await queryOne<{ total: number | string }>(
    `select count(distinct sa.athlete_id)::int as total
       from pilot.scheduler_attendance sa
       join pilot.scheduler_classes c
         on c.organization_id = sa.organization_id and c.class_id = sa.class_id
       join pilot.athletes a
         on a.organization_id = sa.organization_id and a.athlete_id = sa.athlete_id
        and a.deleted_at is null
      where sa.organization_id = $1
        and ${countedMarkSql('$2', '$3', '$4')}`,
    [organizationId, now.toISOString(), GYM_TIME_ZONE, today(now)],
  );
  if (!row) throw new Error('FLOOR_COUNT_TOTAL_MISSING');
  return Number(row.total);
}

/**
 * The board's floor for a live count (flag 3; GO 7206014991): from 5 up the number shows, and every
 * count from 0 to 4 is suppressed, 0 included, "live or not". This departs on purpose from the 30-day
 * panel, where 0 reads "No records" (boardSummary.ts boardAggregateStatus): on a live count a 0 next
 * to a 4 would tell the reader which it was.
 */
export function floored(total: number): FlooredCount {
  if (Number.isInteger(total) && total >= BOARD_MINIMUM_COHORT_SIZE) return { status: 'available', count: total };
  return { status: 'insufficient_data', count: null };
}
