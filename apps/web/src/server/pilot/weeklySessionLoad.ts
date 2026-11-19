import { GYM_TIME_ZONE } from '../../lib/gymTime';
import type { SessionRpeMethod } from './contracts';
import { query } from './db';
import { calculateAcuteChronicWorkloadRatio } from './formulas/engine';
import type { NumericObservation } from './formulas/types';

// Weekly session load per athlete, and the "load jumped" comparison the coach
// suggestion rule reads (progressionSuggestions.ts, Rule 6).
//
// WHAT THIS IS AND IS NOT. Session load is session RPE x minutes (Foster
// 2001), the same number #1177 shows beside Avg RPE: computed in the read,
// never stored. The comparison is the acute:chronic workload ratio, computed
// through the formula engine's own CORE-13 (calculateAcuteChronicWorkloadRatio,
// humanReviewRequired). The elite-boxing research synthesis (2026-10-04) rates
// ACWR as CONTESTED and says use it as a flag only, so this module produces a
// prompt for a coach to look, never a score, a limit, a readiness figure or a
// deload instruction. Jason lifted the earlier "no load figure" refusal for
// exactly this coach-facing flag (2026-10-04: "If we need to add capabilities
// we will") and chose the threshold below.
//
// THE RULE, in plain words:
//   * "This week" = the last 7 days, today included.
//   * "Their usual week" = the average weekly load of the 4 weeks before
//     that, counting only weeks that have any logged load (a week with no
//     minutes logged is unknown, not zero).
//   * The rule stays silent unless at least 3 of those 4 weeks have load.
//   * It flags when this week is LOAD_JUMP_RATIO times their usual week or
//     more.
//
// COMPLETE WEEKS ONLY (lane R6-b2, OD-2026-11-17-004: "a per-week share of
// rated sessions, and a ratio that stays silent otherwise; no imputed numbers
// on screen"). Each week is read against the sessions the athlete actually
// attended (getWeeklyLoadCoverage) and the coach's rest/away marks
// (restMarks.ts), and gets one status: logged, partly logged, rest (marked)
// or not logged. The ratio speaks only when this week is logged, no usual week
// is partly logged, and at least LOAD_JUMP_MIN_PRIOR_WEEKS usual weeks are
// known (logged, or a marked rest week, which counts as a recorded 0 --
// Overwatch 2026-11-19, so a jump after a break is flagged, not hidden). A
// week nobody logged is still unknown and still left out. Nothing here fills
// a gap with a made-up number.
//
// Only an athlete post-session self-report with both RPE and minutes counts,
// the exact provenance rule performanceAnalytics.ts uses: an UNKNOWN-method
// RPE may be the old pre-session readiness slider, and readiness x minutes is
// not load.

/** Jason 2026-10-04: flag at 2.0x the usual week. Change here only. */
export const LOAD_JUMP_RATIO = 2.0;
/** Weeks of history before "this week" that the usual week is averaged over. */
export const LOAD_JUMP_PRIOR_WEEKS = 4;
/** Minimum of those prior weeks that must carry load before the rule speaks. */
export const LOAD_JUMP_MIN_PRIOR_WEEKS = 3;

/**
 * The share of a week's attended sessions that must carry both a rating and
 * minutes for the week to count as logged (Overwatch 2026-11-19; the finding
 * leaves the threshold to the app). 3 of 4 counts; 2 of 3 does not.
 * COST: a week missing up to a quarter of its ratings still counts, and its
 * load is only the rated sessions, so a true 1.5x week can read as 2.0x when
 * the usual weeks were fully rated. Change here only.
 */
export const RATED_SHARE_MIN = 0.75;

/**
 * Marked days a week with nothing attended needs to count as a rest week
 * (Overwatch 2026-11-19, R6-b2 review). The weeks roll forward a day at a
 * time, so a 7-day mark straddles two of them on 6 days out of 7; at 4 of 7
 * it lands in exactly one, and one tap is one rest week, never two zeros.
 * COST: a short mark (1-3 days) in an otherwise empty week makes no rest
 * week: that week stays "not logged" (unknown, skipped), never 0.
 * Change here only.
 */
export const REST_WEEK_MIN_MARKED_DAYS = 4;

const SESSION_RPE_SELF_REPORT: SessionRpeMethod = 'athlete_post_session_self_report';

/** One athlete's summed session load for one 7-day bucket. week_index 0 is
 * the last 7 days (today included), 1 the 7 days before that, and so on. */
export interface WeeklyLoadRow {
  athlete_id: string;
  week_index: number;
  week_load: number;
  session_count: number;
  /** Summed minutes of the same sessions; the under-18 family wording reads it. */
  week_minutes: number;
}

export interface LoadJumpReading {
  athlete_id: string;
  acute_load: number;
  usual_weekly_load: number;
  ratio: number;
  /** The usual weeks the average is over: logged weeks plus marked rest
   * weeks (a recorded 0). The name predates rest marks; it is kept because
   * confirmed gaps store it in their evidence. */
  prior_weeks_with_load: number;
}

/**
 * "Today" is the GYM's day, not the database's. pilot.sessions.date is the
 * gym's calendar date, and Postgres' current_date follows the server's zone
 * (UTC on Azure), which after 8pm in Punxsutawney is already tomorrow: the
 * 7-day window would slip a day every evening. Built from GYM_TIME_ZONE as
 * blockReview.ts and sessionNotes.ts do. `asOf` exists so a test can pin the
 * instant; the rule leaves it as now, and the under-18 family wording passes
 * the gap's confirm time so its numbers are the confirmed week's.
 */
const GYM_TODAY_SQL = `($4::timestamptz at time zone '${GYM_TIME_ZONE}')::date`;

export async function getWeeklySessionLoads(
  organizationId: string,
  athleteIds: readonly string[],
  asOf: Date = new Date(),
): Promise<WeeklyLoadRow[]> {
  if (athleteIds.length === 0) return [];
  // (gym today - date) is a whole number of days; div 7 buckets it.
  // The date window covers exactly weeks 0..LOAD_JUMP_PRIOR_WEEKS, and
  // future-dated rows are left out rather than counted as "this week".
  return query<WeeklyLoadRow>(
    `select athlete_id,
            ((${GYM_TODAY_SQL} - date) / 7)::int as week_index,
            sum(rpe * duration_minutes)::float8 as week_load,
            count(*)::int as session_count,
            sum(duration_minutes)::float8 as week_minutes
     from pilot.sessions
     where organization_id = $1 and athlete_id = any($2::text[])
       and rpe_method = '${SESSION_RPE_SELF_REPORT}'
       and rpe is not null and duration_minutes is not null
       and date <= ${GYM_TODAY_SQL}
       and date > ${GYM_TODAY_SQL} - ($3::int * 7)
     group by athlete_id, ((${GYM_TODAY_SQL} - date) / 7)`,
    [organizationId, [...athleteIds], LOAD_JUMP_PRIOR_WEEKS + 1, asOf.toISOString()],
  );
}

/** One athlete's attended, rated and rest-marked counts for one 7-day bucket. */
export interface WeeklyCoverageRow {
  athlete_id: string;
  week_index: number;
  /** Sessions attended: session rows (an open one dated today not yet), plus
   * register days marked present that have no session row. */
  attended: number;
  /** Of those, the sessions Rule 6 counts: self-reported RPE AND minutes. */
  rated: number;
  /** Days in the bucket covered by a live rest or away mark. */
  marked_days: number;
}

export type LoadWeekStatus = 'logged' | 'partly_logged' | 'rest_marked' | 'not_logged';

export interface LoadWeekCoverage extends Omit<WeeklyCoverageRow, 'athlete_id'> {
  status: LoadWeekStatus;
}

/**
 * Per athlete and Rule 6 bucket (weeks 0..LOAD_JUMP_PRIOR_WEEKS, the same
 * gym-day reduction as getWeeklySessionLoads): how many sessions they
 * attended, how many of those carry a rating and minutes, and how many days a
 * coach marked rest or away. One row per athlete and week, zeros included,
 * for every athlete named. Attendance is read from the reconciled register
 * view (attendancePrecedence.ts, CT-13), never a source table; a register day
 * that already has a session row is that session, not another one.
 */
export async function getWeeklyLoadCoverage(
  organizationId: string,
  athleteIds: readonly string[],
  asOf: Date = new Date(),
): Promise<WeeklyCoverageRow[]> {
  if (athleteIds.length === 0) return [];
  const openToday = `(completed_flag = false and date = ${GYM_TODAY_SQL})`;
  return query<WeeklyCoverageRow>(
    `with window_days as (
       select a.athlete_id, d::date as day
         from unnest($2::text[]) as a(athlete_id)
        cross join generate_series(${GYM_TODAY_SQL} - ($3::int * 7 - 1), ${GYM_TODAY_SQL}, interval '1 day') as d
     ),
     sessions_by_day as (
       select athlete_id, date as day,
              count(*) filter (where not ${openToday})::int as counted,
              count(*) filter (
                where not ${openToday}
                  and rpe_method = '${SESSION_RPE_SELF_REPORT}'
                  and rpe is not null and duration_minutes is not null
              )::int as rated
         from pilot.sessions
        where organization_id = $1 and athlete_id = any($2::text[])
          and date <= ${GYM_TODAY_SQL}
          and date > ${GYM_TODAY_SQL} - ($3::int * 7)
        group by athlete_id, date
     ),
     present_days as (
       select distinct athlete_id, attendance_date as day
         from pilot.attendance_reconciled
        where organization_id = $1 and athlete_id = any($2::text[])
          and status = 'present'
          and attendance_date <= ${GYM_TODAY_SQL}
          and attendance_date > ${GYM_TODAY_SQL} - ($3::int * 7)
     ),
     marked_days as (
       select distinct w.athlete_id, w.day
         from window_days w
         join pilot.athlete_rest_marks m
           on m.organization_id = $1 and m.athlete_id = w.athlete_id
          and m.cleared_at is null
          and w.day between m.first_day and m.last_day
     )
     select w.athlete_id,
            ((${GYM_TODAY_SQL} - w.day) / 7)::int as week_index,
            coalesce(sum(case when s.day is not null then s.counted when p.day is not null then 1 else 0 end), 0)::int as attended,
            coalesce(sum(s.rated), 0)::int as rated,
            count(md.day)::int as marked_days
       from window_days w
       left join sessions_by_day s on s.athlete_id = w.athlete_id and s.day = w.day
       left join present_days p on p.athlete_id = w.athlete_id and p.day = w.day
       left join marked_days md on md.athlete_id = w.athlete_id and md.day = w.day
      group by w.athlete_id, ((${GYM_TODAY_SQL} - w.day) / 7)`,
    [organizationId, [...athleteIds], LOAD_JUMP_PRIOR_WEEKS + 1, asOf.toISOString()],
  );
}

/**
 * Pure: one week's status. Nothing attended is never a share ("0 of 0"): it
 * is rest when a coach marked at least REST_WEEK_MIN_MARKED_DAYS of its days,
 * otherwise not logged. A mark on a week the athlete attended does not hide
 * the sessions: the share decides.
 */
export function classifyLoadWeek(attended: number, rated: number, markedDays: number): LoadWeekStatus {
  if (!(attended > 0)) return markedDays >= REST_WEEK_MIN_MARKED_DAYS ? 'rest_marked' : 'not_logged';
  return rated / attended >= RATED_SHARE_MIN ? 'logged' : 'partly_logged';
}

/** Pure: one athlete's 5 weeks, newest first; a week with no row reads as nothing known. */
export function readLoadWeekCoverage(
  rows: readonly WeeklyCoverageRow[],
  athleteId: string,
): LoadWeekCoverage[] {
  const byWeek = new Map<number, WeeklyCoverageRow>();
  for (const row of rows) {
    if (row.athlete_id === athleteId) byWeek.set(Number(row.week_index), row);
  }
  const weeks: LoadWeekCoverage[] = [];
  for (let week = 0; week <= LOAD_JUMP_PRIOR_WEEKS; week += 1) {
    const row = byWeek.get(week);
    const attended = Number(row?.attended ?? 0);
    const rated = Number(row?.rated ?? 0);
    const markedDays = Number(row?.marked_days ?? 0);
    weeks.push({
      week_index: week,
      attended,
      rated,
      marked_days: markedDays,
      status: classifyLoadWeek(attended, rated, markedDays),
    });
  }
  return weeks;
}

function loadObservation<TKind extends 'acute_load' | 'chronic_load'>(
  organizationId: string,
  athleteId: string,
  kind: TKind,
  value: number,
  observedAt: string,
): NumericObservation<TKind, 'au'> {
  return {
    observationId: `${athleteId}:${kind}`,
    organizationId,
    athleteId,
    contextId: `${athleteId}:load-jump-window`,
    kind,
    value,
    unit: 'au',
    observedAt,
    // An athlete's own rating and minutes: entered by hand, not instrumented.
    source: { type: 'manual', quality: 'moderate', referenceId: `pilot.sessions:${athleteId}` },
  };
}

/**
 * Pure: per athlete, this week's load against their usual week, via CORE-13.
 * Returns only athletes whose weeks are complete enough for a ratio to mean
 * anything (see COMPLETE WEEKS ONLY above); whether the ratio clears
 * LOAD_JUMP_RATIO is the caller's (the suggestion rule's) test. `coverage` is
 * required: without it there is no way to tell a rest week from a week
 * nobody logged, and the ratio stays silent rather than guess.
 */
export function readLoadJumps(
  organizationId: string,
  rows: readonly WeeklyLoadRow[],
  coverage: readonly WeeklyCoverageRow[],
  computedAt: string = new Date().toISOString(),
): LoadJumpReading[] {
  const byAthlete = new Map<string, Map<number, number>>();
  for (const row of rows) {
    if (row.week_index < 0 || row.week_index > LOAD_JUMP_PRIOR_WEEKS) continue;
    if (!byAthlete.has(row.athlete_id)) byAthlete.set(row.athlete_id, new Map());
    byAthlete.get(row.athlete_id)!.set(row.week_index, Number(row.week_load));
  }

  const readings: LoadJumpReading[] = [];
  for (const [athleteId, weeks] of byAthlete) {
    const status = readLoadWeekCoverage(coverage, athleteId);
    // This week must be logged: a partly rated or unlogged week is not a
    // small week, it is an unknown one.
    if (status[0].status !== 'logged') continue;
    const usualWeeks = status.slice(1);
    // A partly rated usual week would pull "usual" down and make an ordinary
    // week look like a jump.
    if (usualWeeks.some((week) => week.status === 'partly_logged')) continue;

    // Known usual weeks: logged ones at their load, marked rest weeks at 0.
    // Not-logged weeks are unknown and left out, as before.
    const prior: number[] = [];
    let loggedWithLoad = 0;
    for (const week of usualWeeks) {
      if (week.status === 'logged') {
        const load = weeks.get(week.week_index) ?? 0;
        if (load > 0) loggedWithLoad += 1;
        prior.push(load);
      } else if (week.status === 'rest_marked') {
        prior.push(0);
      }
    }
    if (prior.length < LOAD_JUMP_MIN_PRIOR_WEEKS || loggedWithLoad === 0) continue;

    const acute = weeks.get(0) ?? 0;
    const usual = prior.reduce((sum, load) => sum + load, 0) / prior.length;
    const result = calculateAcuteChronicWorkloadRatio({
      acute: loadObservation(organizationId, athleteId, 'acute_load', acute, computedAt),
      chronic: loadObservation(organizationId, athleteId, 'chronic_load', usual, computedAt),
      computedAt,
    });
    if (result.value == null) continue;

    readings.push({
      athlete_id: athleteId,
      acute_load: acute,
      usual_weekly_load: usual,
      ratio: result.value,
      prior_weeks_with_load: prior.length,
    });
  }
  return readings;
}

/** The plain numbers an under-18 athlete and their parents read for a
 * confirmed load-jump gap (OD-2026-11-17-004, OW25-31 A): sessions and minutes
 * this week, against the low-high range of the usual weeks. */
export interface FamilyLoadNumbers {
  this_week: { sessions: number; minutes: number };
  usual: { sessions_low: number; sessions_high: number; minutes_low: number; minutes_high: number };
}

/**
 * Pure: one athlete's family numbers from the same bucketed rows Rule 6
 * reads. The usual weeks are the weeks 1..LOAD_JUMP_PRIOR_WEEKS with logged
 * load (an empty week is unknown, not zero), under the same
 * LOAD_JUMP_MIN_PRIOR_WEEKS floor. Since lane R6-b2, readLoadJumps also counts
 * marked rest weeks (as 0) and goes silent on partly logged weeks; this
 * read does not count rest weeks, so when they made up Rule 6's floor it
 * returns null and the family reads R6-a's fixed no-number line (Overwatch
 * 2026-11-19, R6-b2 design point 4). Null when there is
 * no honest number to show: too few usual weeks, nothing in this week, or a
 * value that is not a finite number. Never a made-up figure.
 */
export function readFamilyLoadNumbers(
  rows: readonly WeeklyLoadRow[],
  athleteId: string,
): FamilyLoadNumbers | null {
  const weeks = new Map<number, { load: number; sessions: number; minutes: number }>();
  for (const row of rows) {
    if (row.athlete_id !== athleteId) continue;
    if (row.week_index < 0 || row.week_index > LOAD_JUMP_PRIOR_WEEKS) continue;
    const week = {
      load: Number(row.week_load),
      sessions: Number(row.session_count),
      minutes: Math.round(Number(row.week_minutes)),
    };
    if (![week.load, week.sessions, week.minutes].every(Number.isFinite)) return null;
    weeks.set(row.week_index, week);
  }

  const usual = [];
  for (let index = 1; index <= LOAD_JUMP_PRIOR_WEEKS; index += 1) {
    const week = weeks.get(index);
    if (week && week.load > 0) usual.push(week);
  }
  const thisWeek = weeks.get(0);
  if (usual.length < LOAD_JUMP_MIN_PRIOR_WEEKS || !thisWeek || thisWeek.sessions <= 0 || thisWeek.load <= 0) {
    return null;
  }

  const sessions = usual.map((week) => week.sessions);
  const minutes = usual.map((week) => week.minutes);
  return {
    this_week: { sessions: thisWeek.sessions, minutes: thisWeek.minutes },
    usual: {
      sessions_low: Math.min(...sessions),
      sessions_high: Math.max(...sessions),
      minutes_low: Math.min(...minutes),
      minutes_high: Math.max(...minutes),
    },
  };
}
