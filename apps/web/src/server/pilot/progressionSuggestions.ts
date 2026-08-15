import { query } from './db';
import {
  getPerformanceRollup,
  PERFORMANCE_WINDOW_DAYS_DEFAULT,
  type AthletePerformanceRow,
} from './performanceAnalytics';

// Deterministic gap suggestions (owner decision 2026-08-15, recorded in
// docs/current/ACTIVE_WORK.md): simple transparent rules over records the gym
// already keeps, producing SUGGESTED gaps that a coach confirms or dismisses.
//
// The boundaries this module is built around:
//
//   * SUGGESTIONS ARE COMPUTED, NEVER STORED. pilot.progression_gaps has a
//     check-constrained status vocabulary with no 'suggested' state, and that
//     is treated as a feature: nothing an athlete can ever see exists until a
//     coach confirms a suggestion, at which point the coach's confirmation
//     creates an ordinary gap through the ordinary route. There is no
//     shadow-queue of machine opinions sitting in the database.
//
//   * NO ML, NO SCORES, NO INFERENCE. Every rule is an arithmetic comparison
//     a coach can check by hand against the same numbers the analytics page
//     shows them. The SHADOW statistics lane owns real inference; these rules
//     deliberately do not reach for it.
//
//   * EACH RULE REFUSES THIN DATA. A direction read into two check-ins or a
//     single training day is noise wearing a trend's clothes; every rule has
//     an explicit floor below which it stays silent.
//
//   * AN OPEN GAP SUPPRESSES ITS OWN TYPE. If the coach already has an open
//     gap of the type a rule would suggest, the rule says nothing -- the work
//     is already on the coach's board.
//
// gap_type must land inside the schema's check constraint
// ('technique','strength','endurance','skill','mental','tactical'), so each
// rule maps to the nearest honest bucket and the evidence carries the detail.

export const READINESS_DROP_POINTS = 1.0;
export const READINESS_MIN_CHECKINS_PER_HALF = 2;
export const TRAINING_DAYS_MIN_EARLY = 3;
export const TRAINING_DAYS_DROP_RATIO = 0.5;

export type SuggestionRule = 'readiness_falling' | 'training_days_dropping' | 'assignments_stalled';

export interface GapSuggestion {
  athlete_id: string;
  rule: SuggestionRule;
  gap_type: 'endurance' | 'mental';
  suggested_description: string;
  evidence: Record<string, number | string>;
}

export interface StalledAssignmentRow {
  athlete_id: string;
  stalled_count: number;
  oldest_due_date: string;
}

/**
 * Pure rule evaluation over already-fetched aggregates. Exported separately
 * from the query wrapper so the rules are testable with no database and a
 * coach-facing doc can state them from one place.
 */
export function deriveSuggestions(
  rollup: readonly AthletePerformanceRow[],
  stalled: readonly StalledAssignmentRow[],
  openGapTypesByAthlete: ReadonlyMap<string, ReadonlySet<string>>,
): GapSuggestion[] {
  const suggestions: GapSuggestion[] = [];

  const openTypes = (athleteId: string) => openGapTypesByAthlete.get(athleteId) ?? new Set<string>();

  for (const row of rollup) {
    // Rule 1: readiness falling. Both halves of the window must carry enough
    // check-ins to mean anything, and the newer half must sit at least
    // READINESS_DROP_POINTS below the older one.
    if (
      row.readiness_early_avg != null
      && row.readiness_late_avg != null
      && row.readiness_early_count >= READINESS_MIN_CHECKINS_PER_HALF
      && row.readiness_late_count >= READINESS_MIN_CHECKINS_PER_HALF
      && row.readiness_early_avg - row.readiness_late_avg >= READINESS_DROP_POINTS
      && !openTypes(row.athlete_id).has('endurance')
    ) {
      suggestions.push({
        athlete_id: row.athlete_id,
        rule: 'readiness_falling',
        gap_type: 'endurance',
        suggested_description:
          `Readiness check-ins fell from an average of ${row.readiness_early_avg.toFixed(1)} to `
          + `${row.readiness_late_avg.toFixed(1)} across the recent window. Worth a recovery/conditioning look.`,
        evidence: {
          readiness_early_avg: Number(row.readiness_early_avg.toFixed(2)),
          readiness_late_avg: Number(row.readiness_late_avg.toFixed(2)),
          readiness_early_count: row.readiness_early_count,
          readiness_late_count: row.readiness_late_count,
        },
      });
    }

    // Rule 2: training days dropping. Only fires when the older half showed a
    // real habit (TRAINING_DAYS_MIN_EARLY distinct days) that the newer half
    // has lost at least half of.
    if (
      row.training_days_early >= TRAINING_DAYS_MIN_EARLY
      && row.training_days_late <= row.training_days_early * TRAINING_DAYS_DROP_RATIO
      && !openTypes(row.athlete_id).has('mental')
    ) {
      suggestions.push({
        athlete_id: row.athlete_id,
        rule: 'training_days_dropping',
        gap_type: 'mental',
        suggested_description:
          `Training days dropped from ${row.training_days_early} to ${row.training_days_late} between the older `
          + `and newer halves of the window. Worth a consistency conversation.`,
        evidence: {
          training_days_early: row.training_days_early,
          training_days_late: row.training_days_late,
        },
      });
    }
  }

  // Rule 3: assignments stalled past their due date. Grouped per athlete so a
  // kid with three overdue drills gets one suggestion, not three.
  for (const row of stalled) {
    if (openTypes(row.athlete_id).has('mental')) continue;
    // One 'mental' suggestion per athlete: if rule 2 already spoke for this
    // athlete, fold the stalled evidence into silence rather than doubling up.
    if (suggestions.some((s) => s.athlete_id === row.athlete_id && s.gap_type === 'mental')) continue;

    suggestions.push({
      athlete_id: row.athlete_id,
      rule: 'assignments_stalled',
      gap_type: 'mental',
      suggested_description:
        `${row.stalled_count} drill assignment${row.stalled_count === 1 ? '' : 's'} past due `
        + `(oldest due ${row.oldest_due_date}) without completion. Worth a follow-through check.`,
      evidence: {
        stalled_count: row.stalled_count,
        oldest_due_date: row.oldest_due_date,
      },
    });
  }

  return suggestions;
}

async function getStalledAssignments(
  organizationId: string,
  athleteIds: readonly string[],
): Promise<StalledAssignmentRow[]> {
  if (athleteIds.length === 0) return [];
  return query<StalledAssignmentRow>(
    `select athlete_id,
            count(*)::int as stalled_count,
            min(due_date)::text as oldest_due_date
     from pilot.drill_assignments
     where organization_id = $1 and athlete_id = any($2::text[])
       and status in ('assigned', 'in_progress')
       and due_date is not null and due_date < now()::date
       and completion_percentage < 100
     group by athlete_id`,
    [organizationId, [...athleteIds]],
  );
}

async function getOpenGapTypes(
  organizationId: string,
  athleteIds: readonly string[],
): Promise<Map<string, Set<string>>> {
  if (athleteIds.length === 0) return new Map();
  const rows = await query<{ athlete_id: string; gap_type: string }>(
    `select distinct athlete_id, gap_type
     from pilot.progression_gaps
     where organization_id = $1 and athlete_id = any($2::text[])
       and status in ('identified', 'assigned', 'in_progress')`,
    [organizationId, [...athleteIds]],
  );
  const byAthlete = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!byAthlete.has(row.athlete_id)) byAthlete.set(row.athlete_id, new Set());
    byAthlete.get(row.athlete_id)!.add(row.gap_type);
  }
  return byAthlete;
}

export async function getGapSuggestions(
  organizationId: string,
  athleteIds: readonly string[],
): Promise<GapSuggestion[]> {
  if (athleteIds.length === 0) return [];
  const [rollup, stalled, openGaps] = await Promise.all([
    getPerformanceRollup(organizationId, athleteIds, PERFORMANCE_WINDOW_DAYS_DEFAULT),
    getStalledAssignments(organizationId, athleteIds),
    getOpenGapTypes(organizationId, athleteIds),
  ]);
  return deriveSuggestions(rollup, stalled, openGaps);
}
