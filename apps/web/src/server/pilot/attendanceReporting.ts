import { query } from './db';

// Read-side rollups over pilot.scheduler_attendance -- the attendance store
// that already exists (schedulerDb.ts writes it, the scheduler route's
// attendance_checkin/bulk_attendance_checkin actions populate it). This
// module adds no new attendance data; it only aggregates what is already
// recorded, for the surfaces that had no reporting layer before (capability
// #122's dashboard, #173's Attendance Dashboard).
//
// Truth on screen: an athlete who has never been marked for a class carries
// `attendance_rate: null` and `total_marked: 0`, not a fabricated 0%. A 0%
// rate is a real, reported claim ("this athlete was marked absent every
// time"); "no data yet" is a different fact and must render as such.

export interface AttendanceAthleteSummary {
  athlete_id: string;
  full_name: string;
  present_count: number;
  absent_count: number;
  excused_count: number;
  total_marked: number;
  last_marked_at: string | null;
  /**
   * present / (present + absent), rounded to 3 decimal places. Excused marks
   * are not counted against the rate -- an excused absence is not the same
   * claim as an unexcused one. `null` when there is no present/absent mark
   * to compute a rate from yet (an excused-only or entirely unmarked athlete).
   */
  attendance_rate: number | null;
}

export interface AttendanceClassRosterRow {
  athlete_id: string;
  full_name: string;
  status: 'present' | 'absent' | 'excused' | null;
  method: string | null;
  note: string | null;
  checked_in_at: string | null;
}

interface OrganizationSummaryRow {
  athlete_id: string;
  full_name: string;
  present_count: number;
  absent_count: number;
  excused_count: number;
  total_marked: number;
  last_marked_at: string | null;
}

function computeAttendanceRate(presentCount: number, absentCount: number): number | null {
  const denominator = presentCount + absentCount;
  if (denominator === 0) return null;
  return Math.round((presentCount / denominator) * 1000) / 1000;
}

export interface AttendanceSummaryOptions {
  /**
   * Restrict both the roster and the rollup to classes owned by this coach
   * (coach_account_id, scheduled_by_account_id, or covering_coach_account_id).
   * Omit for an organization-wide summary.
   */
  coachAccountId?: string;
  /** Only count attendance marks at or after this timestamp. */
  sinceIso?: string;
}

/**
 * One row per athlete: how many times they were marked present/absent/excused,
 * and the resulting rate. Includes every active athlete in scope even if they
 * have never been marked (0 counts, `attendance_rate: null`), so a gap in
 * recording is visible on the dashboard rather than the athlete silently not
 * appearing.
 */
export async function getOrganizationAttendanceSummary(
  organizationId: string,
  options: AttendanceSummaryOptions = {},
): Promise<AttendanceAthleteSummary[]> {
  const coachAccountId = options.coachAccountId ?? null;
  const sinceIso = options.sinceIso ?? null;

  const rows = await query<OrganizationSummaryRow>(
    `select
       ath.athlete_id,
       ath.full_name,
       coalesce(agg.present_count, 0)::int as present_count,
       coalesce(agg.absent_count, 0)::int as absent_count,
       coalesce(agg.excused_count, 0)::int as excused_count,
       coalesce(agg.total_marked, 0)::int as total_marked,
       agg.last_marked_at
     from pilot.athletes ath
     left join (
       select
         a.athlete_id,
         count(*) filter (where a.status = 'present') as present_count,
         count(*) filter (where a.status = 'absent') as absent_count,
         count(*) filter (where a.status = 'excused') as excused_count,
         count(*) as total_marked,
         max(a.checked_in_at)::text as last_marked_at
       from pilot.scheduler_attendance a
       join pilot.scheduler_classes c
         on c.organization_id = a.organization_id and c.class_id = a.class_id
       -- Only marks backed by a live registration count. An attendance row
       -- for an athlete never registered in that class appears on no class
       -- roster, so counting it here would put a number on the dashboard
       -- that no drill-down surface can explain or correct. The write paths
       -- now refuse such marks; this join keeps any that predate that
       -- enforcement from inflating rates forever.
       join pilot.scheduler_registrations reg
         on reg.organization_id = a.organization_id
         and reg.class_id = a.class_id
         and reg.athlete_id = a.athlete_id
         and reg.status = 'registered'
       where a.organization_id = $1
         and (
           $2::text is null
           or c.coach_account_id = $2
           or c.scheduled_by_account_id = $2
           or c.covering_coach_account_id = $2
         )
         and ($3::timestamptz is null or a.checked_in_at >= $3)
       group by a.athlete_id
     ) agg on agg.athlete_id = ath.athlete_id
     where ath.organization_id = $1
       and ath.active_flag = true
       and (
         $2::text is null
         or agg.athlete_id is not null
         or exists (
           select 1
           from pilot.scheduler_registrations r
           join pilot.scheduler_classes rc
             on rc.organization_id = r.organization_id and rc.class_id = r.class_id
           where r.organization_id = ath.organization_id
             and r.athlete_id = ath.athlete_id
             and r.status = 'registered'
             and (
               rc.coach_account_id = $2
               or rc.scheduled_by_account_id = $2
               or rc.covering_coach_account_id = $2
             )
         )
       )
     order by ath.full_name`,
    [organizationId, coachAccountId, sinceIso],
  );

  return rows.map((row) => ({
    athlete_id: row.athlete_id,
    full_name: row.full_name,
    present_count: row.present_count,
    absent_count: row.absent_count,
    excused_count: row.excused_count,
    total_marked: row.total_marked,
    last_marked_at: row.last_marked_at,
    attendance_rate: computeAttendanceRate(row.present_count, row.absent_count),
  }));
}

/**
 * Every athlete registered for one class, left-joined against that class's
 * attendance row. `status: null` means "registered, never marked" --
 * rendered on screen as "Unrecorded", never coerced to "Absent". Fabricating
 * an absence for a class nobody has taken attendance for yet would be a
 * false claim about a specific session.
 */
export async function getClassAttendanceRoster(
  organizationId: string,
  classId: string,
): Promise<AttendanceClassRosterRow[]> {
  return query<AttendanceClassRosterRow>(
    `select
       ath.athlete_id,
       ath.full_name,
       a.status,
       a.method,
       a.note,
       a.checked_in_at::text as checked_in_at
     from pilot.scheduler_registrations r
     join pilot.athletes ath
       on ath.organization_id = r.organization_id and ath.athlete_id = r.athlete_id
     left join pilot.scheduler_attendance a
       on a.organization_id = r.organization_id
       and a.class_id = r.class_id
       and a.athlete_id = r.athlete_id
     where r.organization_id = $1
       and r.class_id = $2
       and r.status = 'registered'
     order by ath.full_name`,
    [organizationId, classId],
  );
}

export interface WeeklyAttendanceTrendRow {
  week_start: string;
  present_count: number;
  absent_count: number;
  excused_count: number;
  total_marked: number;
  attendance_rate: number | null;
}

interface WeeklyTrendSummaryRow {
  week_start: string;
  present_count: number;
  absent_count: number;
  excused_count: number;
  total_marked: number;
}

/**
 * Capability #173: the trend admin/attendance/page.tsx had no way to show --
 * getOrganizationAttendanceSummary is a current-snapshot rollup with no
 * week-over-week grouping. Buckets by the CLASS's own start_at (one row per
 * dated session, per pilot.scheduler_classes), not by when a mark was
 * recorded -- a late-entered check-in still belongs to the week the class
 * actually happened. Same registration-backed join as the org summary, for
 * the same reason: an unregistered stray mark must not inflate a week's rate.
 *
 * A week with zero marks is OMITTED, not zero-filled -- attendance-rate:
 * null would be indistinguishable from a real 0% week, and this module's own
 * doctrine (see AttendanceAthleteSummary) is that "no data" and "a reported
 * 0%" must never share a representation. The page fills gaps on render.
 *
 * The window is the `weeks` most recent FULLY COMPLETED weeks -- it excludes
 * the current, still-in-progress week explicitly (c.start_at < this week's
 * start), rather than only bounding from below. An open-ended lower bound
 * alone let the partial current week ride along as an extra, (weeks + 1)th
 * bucket whenever it already had marked attendance, which silently changes
 * the labeled window's width out from under a caller asking for "the last 8
 * weeks."
 */
export async function getWeeklyAttendanceTrend(
  organizationId: string,
  options: { coachAccountId?: string | null; weeks?: number } = {},
): Promise<WeeklyAttendanceTrendRow[]> {
  const coachAccountId = options.coachAccountId ?? null;
  const weeks = Math.min(52, Math.max(1, Math.trunc(options.weeks ?? 8)));

  const rows = await query<WeeklyTrendSummaryRow>(
    `select
       date_trunc('week', c.start_at)::date::text as week_start,
       count(*) filter (where a.status = 'present')::int as present_count,
       count(*) filter (where a.status = 'absent')::int as absent_count,
       count(*) filter (where a.status = 'excused')::int as excused_count,
       count(*)::int as total_marked
     from pilot.scheduler_attendance a
     join pilot.scheduler_classes c
       on c.organization_id = a.organization_id and c.class_id = a.class_id
     join pilot.scheduler_registrations reg
       on reg.organization_id = a.organization_id
       and reg.class_id = a.class_id
       and reg.athlete_id = a.athlete_id
       and reg.status = 'registered'
     where a.organization_id = $1
       and c.start_at >= date_trunc('week', now()) - ($2 * interval '1 week')
       and c.start_at < date_trunc('week', now())
       and (
         $3::text is null
         or c.coach_account_id = $3
         or c.scheduled_by_account_id = $3
         or c.covering_coach_account_id = $3
       )
     group by date_trunc('week', c.start_at)
     order by week_start asc`,
    [organizationId, weeks, coachAccountId],
  );

  return rows.map((row) => ({
    week_start: row.week_start,
    present_count: row.present_count,
    absent_count: row.absent_count,
    excused_count: row.excused_count,
    total_marked: row.total_marked,
    attendance_rate: computeAttendanceRate(row.present_count, row.absent_count),
  }));
}
