import { query } from './db';
import { getTransferReadout, TRANSFER_WINDOW_DAYS } from './falseProgress';
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
//   * A RULE CAN SOURCE FROM ANOTHER MODULE'S VERDICT WITHOUT OWNING IT. The
//     transfer-check rule below reads falseProgress.ts's already-computed
//     not_transferring state as an input and stamps it through the same
//     generic provenance columns every other rule uses. It does not
//     recompute the transfer thresholds -- those stay owned by
//     falseProgress.ts, the same way this module never recomputes readiness
//     or attendance thresholds owned elsewhere.
//
// gap_type must land inside the schema's check constraint
// ('technique','strength','endurance','skill','mental','tactical'), so each
// rule maps to the nearest honest bucket and the evidence carries the detail.

export const READINESS_DROP_POINTS = 1.0;
export const READINESS_MIN_CHECKINS_PER_HALF = 2;
export const TRAINING_DAYS_MIN_EARLY = 3;
export const TRAINING_DAYS_DROP_RATIO = 0.5;

export type SuggestionRule =
  | 'readiness_falling'
  | 'training_days_dropping'
  | 'assignments_stalled'
  | 'transfer_check_failed';

export interface GapSuggestion {
  athlete_id: string;
  rule: SuggestionRule;
  gap_type: 'endurance' | 'mental' | 'skill';
  suggested_description: string;
  evidence: Record<string, number | string>;
}

export interface StalledAssignmentRow {
  athlete_id: string;
  stalled_count: number;
  oldest_due_date: string;
}

// One row per athlete with at least one not_transferring metric in the
// window -- already filtered and grouped by getTransferFailures below, the
// same shape as StalledAssignmentRow: a count plus one concrete example so a
// coach has real counts to check without every failing metric crowding the
// evidence object.
export interface TransferFailureRow {
  athlete_id: string;
  failing_metric_count: number;
  metric_kinds: string;
  example_metric_kind: string;
  example_controlled_makes: number;
  example_controlled_misses: number;
  example_live_makes: number;
  example_live_misses: number;
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
  transferFailures: readonly TransferFailureRow[],
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
  const athletesWithMentalSuggestion = new Set(
    suggestions.filter((s) => s.gap_type === 'mental').map((s) => s.athlete_id),
  );
  for (const row of stalled) {
    if (openTypes(row.athlete_id).has('mental')) continue;
    // One 'mental' suggestion per athlete: if rule 2 already spoke for this
    // athlete, fold the stalled evidence into silence rather than doubling up.
    if (athletesWithMentalSuggestion.has(row.athlete_id)) continue;

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

  // Rule 4: transfer check failed. Sourced from falseProgress.ts's
  // not_transferring verdict (module 053) -- strong in drills, breaking down
  // live. Thin-data refusal already happened upstream in classifyTransfer, so
  // this rule does no threshold math of its own, only suppression and
  // wording. Grouped per athlete like assignments_stalled above: a kid stuck
  // on three metrics gets one board item, not three.
  for (const row of transferFailures) {
    if (openTypes(row.athlete_id).has('skill')) continue;

    suggestions.push({
      athlete_id: row.athlete_id,
      rule: 'transfer_check_failed',
      gap_type: 'skill',
      suggested_description:
        `${row.failing_metric_count} metric${row.failing_metric_count === 1 ? '' : 's'} holding up in practice but `
        + `breaking down live over the last ${TRANSFER_WINDOW_DAYS} days: ${row.metric_kinds}. `
        + `Worth designing live exposure for.`,
      evidence: {
        failing_metric_count: row.failing_metric_count,
        metric_kinds: row.metric_kinds,
        example_metric_kind: row.example_metric_kind,
        example_controlled_makes: row.example_controlled_makes,
        example_controlled_misses: row.example_controlled_misses,
        example_live_makes: row.example_live_makes,
        example_live_misses: row.example_live_misses,
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

// One getTransferReadout call per athlete -- falseProgress.ts only reads one
// athlete's own attempts at a time (never cross-athlete), so there is no
// batched query to call into instead. Gyms run this over a coach's roster,
// not the whole platform, so the fan-out stays small.
async function getTransferFailures(
  organizationId: string,
  athleteIds: readonly string[],
): Promise<TransferFailureRow[]> {
  if (athleteIds.length === 0) return [];
  const perAthlete = await Promise.all(
    athleteIds.map((athleteId) => getTransferReadout(organizationId, athleteId)),
  );

  const rows: TransferFailureRow[] = [];
  perAthlete.forEach((readouts, index) => {
    const failing = readouts.filter((r) => r.state === 'not_transferring');
    if (failing.length === 0) return;
    // getTransferReadout orders by metric_kind, so the first failing entry is
    // a stable pick rather than whichever the join happened to return first.
    const [example] = failing;
    rows.push({
      athlete_id: athleteIds[index],
      failing_metric_count: failing.length,
      metric_kinds: failing.map((m) => m.metric_kind).join(', '),
      example_metric_kind: example.metric_kind,
      example_controlled_makes: example.controlled_makes,
      example_controlled_misses: example.controlled_misses,
      example_live_makes: example.live_makes,
      example_live_misses: example.live_misses,
    });
  });
  return rows;
}

export async function getGapSuggestions(
  organizationId: string,
  athleteIds: readonly string[],
): Promise<GapSuggestion[]> {
  if (athleteIds.length === 0) return [];
  const [rollup, stalled, openGaps, transferFailures] = await Promise.all([
    getPerformanceRollup(organizationId, athleteIds, PERFORMANCE_WINDOW_DAYS_DEFAULT),
    getStalledAssignments(organizationId, athleteIds),
    getOpenGapTypes(organizationId, athleteIds),
    getTransferFailures(organizationId, athleteIds),
  ]);
  return deriveSuggestions(rollup, stalled, openGaps, transferFailures);
}
