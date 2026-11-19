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
 * Returns only athletes with enough history for a ratio to exist; whether the
 * ratio clears LOAD_JUMP_RATIO is the caller's (the suggestion rule's) test.
 */
export function readLoadJumps(
  organizationId: string,
  rows: readonly WeeklyLoadRow[],
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
    const prior: number[] = [];
    for (let week = 1; week <= LOAD_JUMP_PRIOR_WEEKS; week += 1) {
      const load = weeks.get(week);
      if (load != null && load > 0) prior.push(load);
    }
    if (prior.length < LOAD_JUMP_MIN_PRIOR_WEEKS) continue;

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
 * reads. The usual weeks are exactly the ones readLoadJumps averages (weeks
 * 1..LOAD_JUMP_PRIOR_WEEKS with load above zero; an empty week is unknown,
 * not zero) under the same LOAD_JUMP_MIN_PRIOR_WEEKS floor. Null when there is
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
