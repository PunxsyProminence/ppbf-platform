import { formatGymDateTime, GYM_TIME_ZONE } from '../../lib/gymTime';

import { query } from './db';
import { athleteNotDeletedSql } from './deletedAthletes';

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
  /**
   * A reporting period, as gym calendar days (YYYY-MM-DD), inclusive, matched
   * against the day the CLASS was on in the gym's time zone -- not the moment
   * the mark was made, and not UTC's day, so an evening class counts on its
   * own date (RP-01).
   */
  fromDay?: string;
  toDay?: string;
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
  const fromDay = options.fromDay ?? null;
  const toDay = options.toDay ?? null;

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
         and ($4::date is null or (c.start_at at time zone $6::text)::date >= $4::date)
         and ($5::date is null or (c.start_at at time zone $6::text)::date <= $5::date)
       group by a.athlete_id
     ) agg on agg.athlete_id = ath.athlete_id
     where ath.organization_id = $1
       and ath.active_flag = true
       -- active_flag and deleted_at are different things: deletion clears
       -- neither the other's flag nor this row, so both predicates are needed.
       and ath.deleted_at is null
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
    [organizationId, coachAccountId, sinceIso, fromDay, toDay, GYM_TIME_ZONE],
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
       -- Scope B: a deleted athlete is marked deleted with their marks.
       and ath.deleted_at is null
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
  // athleteIds: when set, only these athletes' marks count. Class ownership is
  // self-grantable (cover_class), so a coach's trend is also narrowed to the
  // athletes they reach. An empty array counts nothing; omit for no narrowing.
  options: { coachAccountId?: string | null; athleteIds?: readonly string[]; weeks?: number } = {},
): Promise<WeeklyAttendanceTrendRow[]> {
  const coachAccountId = options.coachAccountId ?? null;
  const athleteIds = options.athleteIds ? [...options.athleteIds] : null;
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
       -- Scope B, and agreement with getOrganizationAttendanceSummary, which
       -- already leaves deleted athletes out: their marks are marked deleted.
       and ${athleteNotDeletedSql('a')}
       and (
         $3::text is null
         or c.coach_account_id = $3
         or c.scheduled_by_account_id = $3
         or c.covering_coach_account_id = $3
       )
       and ($4::text[] is null or a.athlete_id = any($4::text[]))
     group by date_trunc('week', c.start_at)
     order by week_start asc`,
    [organizationId, weeks, coachAccountId, athleteIds],
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

/**
 * THE ATTENDANCE-BY-ATHLETE REPORT, AS CSV (RP-01).
 *
 * The same rows the dashboard shows, for a stated period, written out for a
 * coach or admin to keep. Counts and dates only: no free-text attendance note
 * (RP-01 Q4 default A). The rate is the dashboard's -- present / (present +
 * absent), excused excluded -- and is left BLANK when there is nothing to
 * count, never written as 0 (RP-01 Q1 default A; the module header says why).
 * Times are in gym time.
 *
 * Every cell is quoted, and a cell that a spreadsheet would read as a formula
 * (starting =, +, - or @, or a tab or carriage return that some spreadsheets
 * strip before reading one) is prefixed with an apostrophe, so a name cannot
 * become a formula when the file is opened. The file starts with a UTF-8 byte
 * order mark, so Excel reads an accented name as written.
 */
export function attendanceByAthleteCsv(
  rows: readonly AttendanceAthleteSummary[],
  period: { fromDay: string; toDay: string },
): string {
  const header = ['Athlete', 'Present', 'Absent', 'Excused', 'Marked', 'Attendance rate', 'Last marked (gym time)'];
  const lines = [
    [`Attendance by athlete, ${period.fromDay} to ${period.toDay} (by class date, gym time)`],
    header,
    ...rows.map((row) => [
      row.full_name,
      String(row.present_count),
      String(row.absent_count),
      String(row.excused_count),
      String(row.total_marked),
      row.attendance_rate === null ? '' : `${Math.round(row.attendance_rate * 1000) / 10}%`,
      row.last_marked_at ? formatGymDateTime(row.last_marked_at) ?? '' : '',
    ]),
  ];
  return `\uFEFF${lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/*
 * THE ATTENDANCE REPORT BY CLASS (RP-02). One row per class occurrence whose
 * day in the gym falls in the period (RP-02 Q-A default A): when it was, what
 * it was, its status, how many athletes were registered, and how many of them
 * were marked present, absent or excused. Unmarked is registered minus marked
 * -- a registration nobody took attendance for is not an absence. The rate is
 * the athlete report's (present / (present + absent)), blank when there is
 * nothing to count, and blank for a cancelled class, which keeps its row and
 * counts but is left out of every rate (Q-B default A). Aggregate only: no
 * athlete is named (Q-C default A).
 *
 * Counted: live registrations ('registered'; waitlisted and cancelled
 * registrations are not) of athletes not deleted -- including athletes since
 * made inactive, who did attend that class -- and only marks backed by one of
 * those registrations, as in the athlete summary. For a coach, the classes they
 * own and, within them, the athletes they reach (Q-D default A).
 */
export interface ClassAttendanceReportRow {
  class_id: string;
  title: string;
  start_at: string;
  status: 'open' | 'full' | 'cancelled';
  registered_count: number;
  present_count: number;
  absent_count: number;
  excused_count: number;
  unmarked_count: number;
  attendance_rate: number | null;
}

interface ClassReportSqlRow {
  class_id: string;
  title: string;
  start_at: string;
  status: 'open' | 'full' | 'cancelled';
  registered_count: number;
  present_count: number;
  absent_count: number;
  excused_count: number;
}

export async function getClassAttendanceReport(
  organizationId: string,
  options: { fromDay: string; toDay: string; coachAccountId?: string | null; athleteIds?: readonly string[] },
): Promise<ClassAttendanceReportRow[]> {
  const rows = await query<ClassReportSqlRow>(
    `with classes as (
       select c.class_id, c.title, c.start_at, c.status
         from pilot.scheduler_classes c
        where c.organization_id = $1
          and (c.start_at at time zone $4::text)::date between $2::date and $3::date
          and (
            $5::text is null
            or c.coach_account_id = $5
            or c.scheduled_by_account_id = $5
            or c.covering_coach_account_id = $5
          )
     ),
     registered as (
       select r.class_id, r.athlete_id
         from pilot.scheduler_registrations r
         join classes c on c.class_id = r.class_id
         join pilot.athletes ath
           on ath.organization_id = r.organization_id
          and ath.athlete_id = r.athlete_id
          and ath.deleted_at is null
        where r.organization_id = $1
          and r.status = 'registered'
          and ($6::text[] is null or r.athlete_id = any($6::text[]))
     )
     select c.class_id,
            c.title,
            to_char(c.start_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as start_at,
            c.status,
            coalesce(t.registered_count, 0)::int as registered_count,
            coalesce(t.present_count, 0)::int as present_count,
            coalesce(t.absent_count, 0)::int as absent_count,
            coalesce(t.excused_count, 0)::int as excused_count
       from classes c
       left join lateral (
         select count(*) as registered_count,
                count(*) filter (where a.status = 'present') as present_count,
                count(*) filter (where a.status = 'absent') as absent_count,
                count(*) filter (where a.status = 'excused') as excused_count
           from registered g
           left join pilot.scheduler_attendance a
             on a.organization_id = $1
            and a.class_id = g.class_id
            and a.athlete_id = g.athlete_id
          where g.class_id = c.class_id
       ) t on true
      order by c.start_at, c.title, c.class_id`,
    [
      organizationId,
      options.fromDay,
      options.toDay,
      GYM_TIME_ZONE,
      options.coachAccountId ?? null,
      options.athleteIds ? [...options.athleteIds] : null,
    ],
  );

  return rows.map((row) => ({
    ...row,
    unmarked_count: row.registered_count - row.present_count - row.absent_count - row.excused_count,
    attendance_rate: row.status === 'cancelled' ? null : computeAttendanceRate(row.present_count, row.absent_count),
  }));
}

export interface ClassReportTotals {
  classes: number;
  cancelled: number;
  registered_count: number;
  present_count: number;
  absent_count: number;
  excused_count: number;
  unmarked_count: number;
  attendance_rate: number | null;
}

/**
 * The period's totals over the classes not cancelled: cancelled classes are
 * counted, not added in. A class still to come is in them, its registrations
 * not yet marked -- the label says "not cancelled", not "held".
 */
export function classReportTotals(rows: readonly ClassAttendanceReportRow[]): ClassReportTotals {
  const ran = rows.filter((row) => row.status !== 'cancelled');
  const sum = (key: 'registered_count' | 'present_count' | 'absent_count' | 'excused_count' | 'unmarked_count') =>
    ran.reduce((total, row) => total + row[key], 0);
  const present = sum('present_count');
  const absent = sum('absent_count');
  return {
    classes: ran.length,
    cancelled: rows.length - ran.length,
    registered_count: sum('registered_count'),
    present_count: present,
    absent_count: absent,
    excused_count: sum('excused_count'),
    unmarked_count: sum('unmarked_count'),
    attendance_rate: computeAttendanceRate(present, absent),
  };
}

function ratePercent(rate: number | null): string {
  return rate === null ? '' : `${Math.round(rate * 1000) / 10}%`;
}

/**
 * THE REPORT BY CLASS, AS CSV (RP-02): the same rows, then a total line over
 * the classes that ran. The athlete report's conventions: every cell quoted
 * and formula-guarded, a UTF-8 byte order mark, CRLF, times in gym time.
 */
export function attendanceByClassCsv(
  rows: readonly ClassAttendanceReportRow[],
  period: { fromDay: string; toDay: string },
): string {
  const totals = classReportTotals(rows);
  const header = ['Class', 'Date and time (gym time)', 'Status', 'Registered', 'Present', 'Absent', 'Excused', 'Unmarked', 'Attendance rate'];
  const lines = [
    [`Attendance by class, ${period.fromDay} to ${period.toDay} (by class date, gym time)`],
    header,
    ...rows.map((row) => [
      row.title,
      formatGymDateTime(row.start_at) ?? row.start_at,
      row.status,
      String(row.registered_count),
      String(row.present_count),
      String(row.absent_count),
      String(row.excused_count),
      String(row.unmarked_count),
      ratePercent(row.attendance_rate),
    ]),
    [
      `Total, ${totals.classes} ${totals.classes === 1 ? 'class' : 'classes'} not cancelled${totals.cancelled ? ` (${totals.cancelled} cancelled, not included)` : ''}`,
      '',
      '',
      String(totals.registered_count),
      String(totals.present_count),
      String(totals.absent_count),
      String(totals.excused_count),
      String(totals.unmarked_count),
      ratePercent(totals.attendance_rate),
    ],
  ];
  return `\uFEFF${lines.map((cells) => cells.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function csvCell(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${guarded.replace(/"/g, '""')}"`;
}
