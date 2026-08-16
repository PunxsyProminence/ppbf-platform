import { query } from './db';

// CT-13: the ONE way to ask this platform how many days somebody attended.
//
// Three attendance-shaped tables exist (pilot.attendance,
// pilot.scheduler_attendance, pilot.activity_log) at three different grains.
// Summing any two of them inflates participation by however many athletes
// attend more than one class in a day. The written finding is
// docs/current/ATTENDANCE_PRECEDENCE.md; the enforced version is
// pilot.attendance_reconciled, which this module is the only reader of.
//
// PRECEDENCE, decided in that migration and restated here so a caller does not
// have to open the SQL:
//
//   1. pilot.activity_log  (activity_domain = 'boxing_training')  -- go-forward
//   2. pilot.scheduler_attendance, collapsed to a gym-local day
//   3. pilot.attendance                                           -- legacy
//
// The highest available source wins OUTRIGHT. Lower sources are never added to
// it. Every function here counts rows in the view; none of them touches an
// underlying table, and attendancePrecedence.test.ts fails if any file starts
// to.
//
// WHAT THIS MODULE CANNOT DO. There is no function here that returns two
// athletes' participation in one sortable shape, for the same reason
// achievements.ts has none: a leaderboard between children needs a comparable
// number per athlete, and privacyTiers.ts already lists all three attendance
// tables in PUBLIC_RANKING_FORBIDDEN_TABLES. Organization totals below are
// deliberately scalar counts, not per-athlete arrays.

/** The status vocabulary the view emits. Narrower than pilot.attendance's
 * unconstrained free text, because the view normalises on the way out. */
export type ReconciledAttendanceStatus = 'present' | 'absent' | 'excused';

/** Which table won a given athlete-day. Exposed so a caller can tell how much
 * of a figure rests on legacy records rather than go-forward evidence. */
export type AttendanceSource = 'activity_log' | 'scheduler_attendance' | 'attendance';

export interface ReconciledAttendanceDay {
  organization_id: string;
  athlete_id: string;
  attendance_date: string;
  status: ReconciledAttendanceStatus;
  source: AttendanceSource;
  /** Class-level marks behind this day. Detail only -- never a participation
   * number. An athlete at two classes on Tuesday has one attended day. */
  class_marks_that_day: number;
  /** How many of the three sources spoke about this athlete-day. Greater than
   * 1 means sources overlapped and the highest won; it does NOT mean the
   * athlete attended more than once. */
  contributing_sources: number;
}

const FIELDS = `organization_id, athlete_id, attendance_date::text as attendance_date,
  status, source, class_marks_that_day, contributing_sources`;

/**
 * One athlete's reconciled attendance days, newest first.
 *
 * Every row is one calendar day. Counting the returned rows is a correct
 * participation figure by construction -- that is the property the view
 * guarantees and the reason this function exists instead of a table read.
 */
export async function listAthleteAttendanceDays(
  organizationId: string,
  athleteId: string,
  options: { from?: string; to?: string } = {},
): Promise<ReconciledAttendanceDay[]> {
  return query<ReconciledAttendanceDay>(
    `select ${FIELDS}
     from pilot.attendance_reconciled
     where organization_id = $1
       and athlete_id = $2
       and ($3::date is null or attendance_date >= $3::date)
       and ($4::date is null or attendance_date <= $4::date)
     order by attendance_date desc`,
    [organizationId, athleteId, options.from ?? null, options.to ?? null],
  );
}

export interface AthleteAttendanceTotals {
  athlete_id: string;
  days_present: number;
  days_absent: number;
  days_excused: number;
  /** Distinct calendar days with any mark. present + absent + excused. */
  days_recorded: number;
  first_day: string | null;
  last_day: string | null;
}

/**
 * One athlete's day counts. Safe to quote as "days attended" because the view
 * has already collapsed every source to one row per day.
 *
 * Returns zeroed totals rather than null for an athlete with no record, so a
 * caller renders "0 days" against a real absence of data rather than crashing
 * -- but note that zero days recorded and zero days present are different
 * claims, and `days_recorded` is what distinguishes them.
 */
export async function getAthleteAttendanceTotals(
  organizationId: string,
  athleteId: string,
  options: { from?: string; to?: string } = {},
): Promise<AthleteAttendanceTotals> {
  const rows = await query<{
    days_present: string;
    days_absent: string;
    days_excused: string;
    days_recorded: string;
    first_day: string | null;
    last_day: string | null;
  }>(
    `select
       count(*) filter (where status = 'present')::text as days_present,
       count(*) filter (where status = 'absent')::text  as days_absent,
       count(*) filter (where status = 'excused')::text as days_excused,
       count(*)::text                                   as days_recorded,
       min(attendance_date)::text                       as first_day,
       max(attendance_date)::text                       as last_day
     from pilot.attendance_reconciled
     where organization_id = $1
       and athlete_id = $2
       and ($3::date is null or attendance_date >= $3::date)
       and ($4::date is null or attendance_date <= $4::date)`,
    [organizationId, athleteId, options.from ?? null, options.to ?? null],
  );

  const row = rows[0];
  return {
    athlete_id: athleteId,
    days_present: Number(row?.days_present ?? 0),
    days_absent: Number(row?.days_absent ?? 0),
    days_excused: Number(row?.days_excused ?? 0),
    days_recorded: Number(row?.days_recorded ?? 0),
    first_day: row?.first_day ?? null,
    last_day: row?.last_day ?? null,
  };
}

export interface OrganizationParticipationTotals {
  /** Distinct athletes with at least one PRESENT day in the window. This is
   * the unduplicated participant count a funder report actually asks for. */
  athletes_present: number;
  /** Sum of present athlete-DAYS. One athlete present on ten days contributes
   * ten; one athlete at three classes on one day contributes one. */
  athlete_days_present: number;
  /** Athlete-days whose winning source was the legacy table. Surfaced so a
   * figure can state how much of itself rests on records that predate the
   * go-forward evidence stream, rather than presenting one confidence. */
  athlete_days_from_legacy: number;
  window_from: string | null;
  window_to: string | null;
}

/**
 * Organization-level participation, unduplicated.
 *
 * Two numbers on purpose: funders ask both "how many young people did you
 * serve" (athletes_present) and "how many sessions of service did you deliver"
 * (athlete_days_present), and conflating them is the mistake this whole ticket
 * is about. Neither is derivable from the other, so both are returned.
 *
 * Scalar counts, not a per-athlete list: see the module header.
 */
export async function getOrganizationParticipationTotals(
  organizationId: string,
  options: { from?: string; to?: string } = {},
): Promise<OrganizationParticipationTotals> {
  const rows = await query<{
    athletes_present: string;
    athlete_days_present: string;
    athlete_days_from_legacy: string;
  }>(
    `select
       count(distinct athlete_id) filter (where status = 'present')::text as athletes_present,
       count(*) filter (where status = 'present')::text                   as athlete_days_present,
       count(*) filter (where status = 'present' and source = 'attendance')::text
                                                                         as athlete_days_from_legacy
     from pilot.attendance_reconciled
     where organization_id = $1
       and ($2::date is null or attendance_date >= $2::date)
       and ($3::date is null or attendance_date <= $3::date)`,
    [organizationId, options.from ?? null, options.to ?? null],
  );

  const row = rows[0];
  return {
    athletes_present: Number(row?.athletes_present ?? 0),
    athlete_days_present: Number(row?.athlete_days_present ?? 0),
    athlete_days_from_legacy: Number(row?.athlete_days_from_legacy ?? 0),
    window_from: options.from ?? null,
    window_to: options.to ?? null,
  };
}

/**
 * Athlete-days where more than one source had a row.
 *
 * Not an error report -- overlap is expected once a backfill or a dual-write
 * period exists. It is here so the KPI layer can state how much of a figure
 * came from overlapping sources instead of presenting a single confident
 * number over records that disagree.
 */
export async function listOverlappingSourceDays(
  organizationId: string,
  limit = 100,
): Promise<ReconciledAttendanceDay[]> {
  return query<ReconciledAttendanceDay>(
    `select ${FIELDS}
     from pilot.attendance_reconciled
     where organization_id = $1
       and contributing_sources > 1
     order by attendance_date desc
     limit $2`,
    [organizationId, limit],
  );
}
