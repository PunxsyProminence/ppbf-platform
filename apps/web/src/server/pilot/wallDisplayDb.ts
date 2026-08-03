import { query } from './db';
import { getWallTimeZone } from './env';
import {
  buildWallBoard,
  gymDayBounds,
  MARQUEE_WINDOW_DAYS,
  WALL_MILESTONES,
  type WallAthleteRow,
  type WallAttendanceRow,
  type WallBoard,
  type WallClassRow,
  type WallCrossingRow,
  type WallNameMode,
  type WallNoticeRow,
  type WallWaiverRow,
} from './wallDisplay';

/**
 * The reads behind the wall display. Every SELECT here names its columns, and
 * the list of columns is the privacy boundary as much as the consent gate is:
 *
 *   - scheduler_attendance.note, .method, .checked_in_by_* are NOT read. A
 *     coach's free-text note and "who overrode this check-in" are both about a
 *     person, and neither belongs on a wall.
 *   - Only status = 'present' rows are read at all, so 'absent' and 'excused'
 *     -- a public record of who did not turn up -- cannot reach the screen even
 *     by accident downstream.
 *   - pilot.readiness, pilot.medical_intake, pilot.coach_observations and
 *     pilot.assessments are not queried. Nothing on this screen is a health,
 *     clearance, injury or behaviour fact.
 *   - waivers.notes and waivers.signed_by_name are not read either: the gate
 *     needs the type, the status, the signer's ROLE and the date, and reading a
 *     guardian's name into a public payload would be gratuitous.
 *
 * There is no DDL here and none anywhere under app/api -- pilot.* is owned by
 * infra/azure migrations (httpRoutesCarryNoDdl.test.ts pins that).
 */

export async function loadWallBoard(input: {
  organizationId: string;
  mode: WallNameMode;
  now?: Date;
  timeZone?: string;
}): Promise<WallBoard> {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone ?? getWallTimeZone();
  const { startUtc, endUtc, ymd } = gymDayBounds(now, timeZone);
  const startIso = startUtc.toISOString();
  const endIso = endUtc.toISOString();

  const [classes, attendance, crossings, notices] = await Promise.all([
    query<WallClassRow>(
      `select class_id, title, start_at::text, end_at::text, location, status
       from pilot.scheduler_classes
       where organization_id = $1
         and start_at >= $2::timestamptz
         and start_at <  $3::timestamptz
       order by start_at asc
       limit 24`,
      [input.organizationId, startIso, endIso],
    ),
    query<WallAttendanceRow>(
      `select athlete_id, class_id, checked_in_at::text
       from pilot.scheduler_attendance
       where organization_id = $1
         and status = 'present'
         and checked_in_at >= $2::timestamptz
         and checked_in_at <  $3::timestamptz
       order by checked_in_at desc
       limit 200`,
      [input.organizationId, startIso, endIso],
    ),
    // The Fibonacci ladder, computed where the rows are. row_number() over the
    // athlete's completed sessions gives the crossing session directly, so this
    // never pulls a whole training history across the wire. selectMarquee() is
    // still the authority on which ranks and which window count.
    query<WallCrossingRow>(
      `with ranked as (
         select athlete_id,
                date::text as crossed_on,
                row_number() over (partition by athlete_id order by date asc, session_id asc) as session_number
         from pilot.sessions
         where organization_id = $1 and completed_flag
       )
       select athlete_id, session_number::int as session_number, crossed_on
       from ranked
       where session_number = any($2::int[])
         and crossed_on >= $3
       order by crossed_on desc, session_number desc
       limit 40`,
      [input.organizationId, [...WALL_MILESTONES], shiftDays(ymd, -MARQUEE_WINDOW_DAYS)],
    ),
    query<WallNoticeRow>(
      `select message, author_name, author_role, created_at::text, kind
       from pilot.announcements
       where organization_id = $1
         and active
         and (placement = 'gym_notices' or placement = 'everywhere')
         and (starts_at is null or starts_at <= now())
         and (ends_at is null or ends_at > now())
       order by created_at desc
       limit 5`,
      [input.organizationId],
    ),
  ]);

  // Only the athletes actually named on the board are looked up, and only the
  // three columns the gate needs. A wall endpoint has no reason to hold the
  // roster.
  const athleteIds = [
    ...new Set([...attendance.map((r) => r.athlete_id), ...crossings.map((r) => r.athlete_id)]),
  ];

  const [athletes, waivers] = athleteIds.length
    ? await Promise.all([
        query<WallAthleteRow>(
          `select athlete_id, full_name, dob::text
           from pilot.athletes
           where organization_id = $1 and athlete_id = any($2::text[])`,
          [input.organizationId, athleteIds],
        ),
        query<WallWaiverRow>(
          `select athlete_id, waiver_type, status, signed_by_role, signed_at::text
           from pilot.waivers
           where organization_id = $1 and athlete_id = any($2::text[])`,
          [input.organizationId, athleteIds],
        ),
      ])
    : [[] as WallAthleteRow[], [] as WallWaiverRow[]];

  return buildWallBoard({
    organizationId: input.organizationId,
    now,
    timeZone,
    mode: input.mode,
    classes,
    attendance,
    athletes,
    waivers,
    crossings,
    notices,
  });
}

function shiftDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const moved = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return moved.toISOString().slice(0, 10);
}
