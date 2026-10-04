import { GYM_TIME_ZONE } from '../../lib/gymTime';
import { WELLNESS_SCALES, type WellnessDirection } from '../../shared/wellnessScales';
import { query } from './db';
import { LOAD_JUMP_PRIOR_WEEKS } from './weeklySessionLoad';

// Check-in wellness over the same window as the load-jump read, for the
// coach's "Load up, wellness down" suggestion (progressionSuggestions.ts,
// Rule 7; Jason 2026-10-04, OD-2026-10-04-015).
//
// THE RULE, in plain words:
//   * "This week" = the last 7 gym days, today included -- the same 7 days
//     weeklySessionLoad.ts calls week 0.
//   * "Before" = the 28 days before that -- the same 4 weeks that file
//     averages the usual week over.
//   * An item counts as worse when its average moved at least
//     WELLNESS_SHIFT_POINTS the bad way between the two, with at least
//     WELLNESS_MIN_CHECKINS answers on each side.
//
// WHAT THIS IS NOT. wellnessScales.ts: "Nothing today averages or ranks these
// values, and this field exists so that whatever does it first has to look at
// the direction rather than assume one." This is the first, so:
//   * each item is read on its own and never blended with another, or with
//     readiness (CHECKIN_API_CONTRACT: never blend them with the readiness
//     board);
//   * which way is worse comes from WELLNESS_SCALES' recorded direction, not
//     from this file -- energy is higher_is_better, soreness higher_is_worse;
//   * a skipped answer is null and is left out of both the average and the
//     count; it is never read as a zero or a middle value.
//
// ACCESS. Same shape as every other suggestion input: organization-scoped,
// and only for the athlete ids the caller passes, which the suggestions route
// has already narrowed to the coach's authorised roster (coachAuthorizedRoster)
// or the organization's live roster for an admin. Nothing here widens that.

/** Jason 2026-10-04: energy or soreness are the "down" signal. */
export const WELLNESS_TREND_ITEMS = ['energy', 'soreness'] as const;
export type WellnessTrendItem = (typeof WELLNESS_TREND_ITEMS)[number];

/** Days in "this week"; matches weeklySessionLoad.ts week 0. */
export const WELLNESS_RECENT_DAYS = 7;
/** Days before "this week" compared against; matches the load read's 4 weeks. */
export const WELLNESS_PRIOR_DAYS = LOAD_JUMP_PRIOR_WEEKS * 7;
/** Minimum answers for an item on each side before it is read at all. */
export const WELLNESS_MIN_CHECKINS = 2;
/** How far (1-5 scale points) an average must move the bad way. */
export const WELLNESS_SHIFT_POINTS = 1.0;
const FLOAT_TOLERANCE = 1e-9;

export interface WellnessWindowRow {
  athlete_id: string;
  energy_recent_avg: number | null;
  energy_recent_count: number;
  energy_prior_avg: number | null;
  energy_prior_count: number;
  soreness_recent_avg: number | null;
  soreness_recent_count: number;
  soreness_prior_avg: number | null;
  soreness_prior_count: number;
}

export interface WellnessDecline {
  athlete_id: string;
  item: WellnessTrendItem;
  direction: WellnessDirection;
  recent_avg: number;
  prior_avg: number;
  recent_count: number;
  prior_count: number;
}

// The gym's day, not the database server's (UTC on Azure); the same
// reduction weeklySessionLoad.ts uses, so both reads mean the same 7 days.
const GYM_TODAY_SQL = `($3::timestamptz at time zone '${GYM_TIME_ZONE}')::date`;
const DAYS_BACK_SQL = `(${GYM_TODAY_SQL} - checked_in_on)`;

function itemColumnsSql(item: WellnessTrendItem): string {
  const recent = `${DAYS_BACK_SQL} < ${WELLNESS_RECENT_DAYS}`;
  const prior = `${DAYS_BACK_SQL} >= ${WELLNESS_RECENT_DAYS}`;
  return `(avg(${item}) filter (where ${recent}))::float8 as ${item}_recent_avg,
            (count(${item}) filter (where ${recent}))::int as ${item}_recent_count,
            (avg(${item}) filter (where ${prior}))::float8 as ${item}_prior_avg,
            (count(${item}) filter (where ${prior}))::int as ${item}_prior_count`;
}

export async function getWellnessWindows(
  organizationId: string,
  athleteIds: readonly string[],
  asOf: Date = new Date(),
): Promise<WellnessWindowRow[]> {
  if (athleteIds.length === 0) return [];
  // Future-dated rows are left out rather than counted as "this week", as the
  // load read does.
  return query<WellnessWindowRow>(
    `select athlete_id,
            ${WELLNESS_TREND_ITEMS.map(itemColumnsSql).join(',\n            ')}
     from pilot.athlete_check_ins
     where organization_id = $1 and athlete_id = any($2::text[])
       and checked_in_on <= ${GYM_TODAY_SQL}
       and checked_in_on > ${GYM_TODAY_SQL} - ${WELLNESS_RECENT_DAYS + WELLNESS_PRIOR_DAYS}
     group by athlete_id`,
    [organizationId, [...athleteIds], asOf.toISOString()],
  );
}

function directionOf(item: WellnessTrendItem): WellnessDirection {
  const scale = WELLNESS_SCALES.find((candidate) => candidate.key === item);
  // A missing scale is a code fault, not data: refuse rather than guess a way.
  if (!scale) throw new Error(`WELLNESS_SCALE_MISSING:${item}`);
  return scale.direction;
}

/**
 * Pure: every (athlete, item) whose average got worse by at least
 * WELLNESS_SHIFT_POINTS between the prior 28 days and the last 7, with enough
 * answers on both sides. "Worse" follows the item's recorded direction.
 */
export function readWellnessDeclines(rows: readonly WellnessWindowRow[]): WellnessDecline[] {
  const declines: WellnessDecline[] = [];
  for (const row of rows) {
    for (const item of WELLNESS_TREND_ITEMS) {
      const recentAvg = row[`${item}_recent_avg`];
      const priorAvg = row[`${item}_prior_avg`];
      const recentCount = Number(row[`${item}_recent_count`]);
      const priorCount = Number(row[`${item}_prior_count`]);
      if (recentAvg == null || priorAvg == null) continue;
      if (recentCount < WELLNESS_MIN_CHECKINS || priorCount < WELLNESS_MIN_CHECKINS) continue;

      const direction = directionOf(item);
      const recent = Number(recentAvg);
      const prior = Number(priorAvg);
      const worsening = direction === 'higher_is_better' ? prior - recent : recent - prior;
      // Averages of thirds (4.33 vs 3.33) land a hair under 1.0 in floating
      // point; the tolerance keeps a real one-point move from reading as 0.99.
      if (worsening < WELLNESS_SHIFT_POINTS - FLOAT_TOLERANCE) continue;

      declines.push({
        athlete_id: row.athlete_id,
        item,
        direction,
        recent_avg: recent,
        prior_avg: prior,
        recent_count: recentCount,
        prior_count: priorCount,
      });
    }
  }
  return declines;
}
