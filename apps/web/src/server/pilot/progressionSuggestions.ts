import { query } from './db';
import { getTransferReadout } from './falseProgress';
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

export type SuggestionRule =
  | 'readiness_falling'
  | 'training_days_dropping'
  | 'assignments_stalled'
  | 'transfer_check_failed'
  | 'competition_loss_unresolved';

export interface GapSuggestion {
  athlete_id: string;
  rule: SuggestionRule;
  gap_type: 'endurance' | 'mental' | 'skill' | 'technique';
  suggested_description: string;
  evidence: Record<string, number | string>;
}

export interface StalledAssignmentRow {
  athlete_id: string;
  stalled_count: number;
  oldest_due_date: string;
}

// Rule 4 input: one row per (athlete, metric) that the false-progress module
// (module 053) already classified as 'not_transferring' -- strong in
// controlled practice, weak live, with real attempt counts on both sides.
// Deliberately the same shape falseProgress.ts hands back per metric, so
// this rule adds no interpretation of its own on top of that verdict.
export interface TransferFailureRow {
  athlete_id: string;
  metric_kind: string;
  controlled_makes: number;
  controlled_misses: number;
  live_makes: number;
  live_misses: number;
}

// Rule 5 input: a recorded competition loss (owner doctrine 2026-08-16,
// enforced by the database in externalCompetition.ts): a loss cannot be
// written without a non-blank lesson_note. That fact and its lesson
// currently live only on the external-competition page; Rule 5 below is how
// it reaches Progression Intelligence instead of staying stranded there.
// Grouped per athlete like the stalled-assignment rows, evidenced by the
// most recent loss.
export interface CompetitionLossRow {
  athlete_id: string;
  loss_count: number;
  most_recent_lesson_note: string;
  most_recent_competition_name: string;
  most_recent_competition_date: string;
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
  transferFailures: readonly TransferFailureRow[] = [],
  competitionLosses: readonly CompetitionLossRow[] = [],
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

  // Rule 4: transfer check failed. The false-progress module (module 053)
  // already computes, per athlete per metric, whether a skill that looks
  // mastered in controlled practice (session, drill_assignment, assessment)
  // is holding up in live sparring. A 'not_transferring' verdict is exactly
  // the kind of fact this engine already turns into a suggestion for other
  // signals -- so read it the same way, with no extra inference layered on
  // top of that module's own classification. One suggestion per failing
  // metric, not bundled per athlete: "jab-cross doesn't transfer" and "low
  // kick doesn't transfer" are two different coaching conversations, unlike
  // the interchangeable overdue-drill rows rule 3 bundles.
  for (const failure of transferFailures) {
    if (openTypes(failure.athlete_id).has('skill')) continue;

    const controlledTotal = failure.controlled_makes + failure.controlled_misses;
    const liveTotal = failure.live_makes + failure.live_misses;
    const controlledRate = controlledTotal > 0 ? failure.controlled_makes / controlledTotal : 0;
    const liveRate = liveTotal > 0 ? failure.live_makes / liveTotal : 0;

    suggestions.push({
      athlete_id: failure.athlete_id,
      rule: 'transfer_check_failed',
      gap_type: 'skill',
      suggested_description:
        `${failure.metric_kind} holds up in controlled practice (${failure.controlled_makes}/${controlledTotal}, `
        + `${Math.round(controlledRate * 100)}%) but is not transferring to live sparring `
        + `(${failure.live_makes}/${liveTotal}, ${Math.round(liveRate * 100)}%). Worth a pressure-tested look.`,
      evidence: {
        metric_kind: failure.metric_kind,
        controlled_makes: failure.controlled_makes,
        controlled_misses: failure.controlled_misses,
        live_makes: failure.live_makes,
        live_misses: failure.live_misses,
      },
    });
  }

  // Rule 5: a competitive loss with its mandatory lesson note. Grouped per
  // athlete like Rule 3, so a run of losses produces one suggestion, not one
  // per entry -- evidenced by the most recent lesson so the coach sees the
  // exact note that would otherwise stay stranded on the competition page.
  for (const row of competitionLosses) {
    if (openTypes(row.athlete_id).has('technique')) continue;

    suggestions.push({
      athlete_id: row.athlete_id,
      rule: 'competition_loss_unresolved',
      gap_type: 'technique',
      suggested_description:
        `${row.loss_count} recorded competition loss${row.loss_count === 1 ? '' : 'es'}, most recently at `
        + `${row.most_recent_competition_name} (${row.most_recent_competition_date}): `
        + `"${row.most_recent_lesson_note}". Worth turning the lesson into a tracked gap.`,
      evidence: {
        loss_count: row.loss_count,
        most_recent_competition_name: row.most_recent_competition_name,
        most_recent_competition_date: row.most_recent_competition_date,
        most_recent_lesson_note: row.most_recent_lesson_note,
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

// One row per athlete with an unresolved recorded loss, carrying the most
// recent competition/lesson via a per-athlete window ranking -- the same
// "group but keep the newest detail" shape getStalledAssignments uses,
// joined out to pilot.external_competitions the same way
// listCompetitionEntries in externalCompetition.ts does, for the date and
// name a coach needs to recognize the fight being referenced.
async function getCompetitionLosses(
  organizationId: string,
  athleteIds: readonly string[],
): Promise<CompetitionLossRow[]> {
  if (athleteIds.length === 0) return [];
  return query<CompetitionLossRow>(
    `select athlete_id,
            loss_count::int as loss_count,
            lesson_note as most_recent_lesson_note,
            competition_name as most_recent_competition_name,
            competition_date::text as most_recent_competition_date
     from (
       select e.athlete_id,
              e.lesson_note,
              c.competition_name,
              c.competition_date,
              count(*) over (partition by e.athlete_id) as loss_count,
              row_number() over (
                partition by e.athlete_id
                order by c.competition_date desc, e.updated_at desc
              ) as rn
       from pilot.external_competition_entries e
       join pilot.external_competitions c
         on c.organization_id = e.organization_id and c.competition_id = e.competition_id
       where e.organization_id = $1 and e.athlete_id = any($2::text[]) and e.result = 'lost'
     ) ranked
     where rn = 1`,
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

// Rule 4's data source. falseProgress.ts is deliberately one-athlete-at-a-time
// ("No cross-athlete reads, ever") so this fans out per athlete rather than
// asking that module for a batched query it does not offer.
async function getTransferFailures(
  organizationId: string,
  athleteIds: readonly string[],
): Promise<TransferFailureRow[]> {
  if (athleteIds.length === 0) return [];
  const perAthlete = await Promise.all(
    athleteIds.map(async (athleteId) => {
      const readouts = await getTransferReadout(organizationId, athleteId);
      return readouts
        .filter((readout) => readout.state === 'not_transferring')
        .map((readout) => ({
          athlete_id: athleteId,
          metric_kind: readout.metric_kind,
          controlled_makes: readout.controlled_makes,
          controlled_misses: readout.controlled_misses,
          live_makes: readout.live_makes,
          live_misses: readout.live_misses,
        }));
    }),
  );
  return perAthlete.flat();
}

export async function getGapSuggestions(
  organizationId: string,
  athleteIds: readonly string[],
): Promise<GapSuggestion[]> {
  if (athleteIds.length === 0) return [];
  const [rollup, stalled, openGaps, transferFailures, competitionLosses] = await Promise.all([
    getPerformanceRollup(organizationId, athleteIds, PERFORMANCE_WINDOW_DAYS_DEFAULT),
    getStalledAssignments(organizationId, athleteIds),
    getOpenGapTypes(organizationId, athleteIds),
    getTransferFailures(organizationId, athleteIds),
    getCompetitionLosses(organizationId, athleteIds),
  ]);
  return deriveSuggestions(rollup, stalled, openGaps, transferFailures, competitionLosses);
}

// ---------------------------------------------------------------------------
// GAP JUSTIFICATION -- the narrow, additive read this module also owns.
//
// When a coach confirms a suggestion above (see the coach progression-
// intelligence page's handleConfirmSuggestion), the resulting
// pilot.progression_gaps row is written with detected_from set to
// `deterministic_rule:<rule>` and detection_data set to this module's own
// `evidence` object for that rule. The exact numbers already land in the
// gap's own gap_description as prose (see each rule's suggested_description
// above) -- an athlete or parent reading a confirmed gap today already reads
// "Readiness check-ins fell from an average of 6.5 to 4.2...". This section
// does not disclose a new category of data; it restates that SAME already-
// visible justification as typed fields instead of frozen prose, scoped to
// exactly the rollup fields the rule that flagged this gap actually used.
//
// A manually-created gap (detected_from = 'coach_observation' or anything
// else that is not this prefix) gets no justification: there is no rule
// evidence to restate, and showing rollup numbers next to it would imply a
// connection that was never made.
//
// assignments_stalled is deliberately mapped to an EMPTY field list: its
// evidence (stalled_count, oldest_due_date) comes from getStalledAssignments
// above, which is not part of AthletePerformanceRow / the Performance
// Analytics rollup at all. There is nothing in the rollup to slice for it,
// and the assignment's own due_date/completion_percentage are already visible
// to the athlete/parent via GET /api/pilot/progression/assignments -- so
// this rule contributes no rows to getGapJustifications rather than reaching
// for an approximate substitute.
//
// transfer_check_failed and competition_loss_unresolved are empty for exactly
// the same reason, and between them they are the case that proves the Record's
// exhaustiveness is worth keeping. Rule 4's evidence (metric_kind,
// controlled_makes/misses, live_makes/misses) comes from the false-progress
// readout over pilot.training_attempts; Rule 5's (loss_count, the lesson note,
// the competition name and date) comes from pilot.external_competition_entries.
// Neither is anything the Performance Analytics rollup carries. Reaching for a
// rollup field that merely correlates with a transfer failure or a competition
// loss would be inventing a justification the rule never actually read.
//
// Both were added by PRs that were green in isolation and broke main on merge,
// which is worth stating plainly here: three of the five rules now in this
// union arrived that way. See the "not done" note in the PR that added this
// comment -- the durable fix is a branch-protection setting, not more code.
//
// The map is typed Record<SuggestionRule, ...> rather than Partial<...> on
// purpose: a new rule cannot be added to the union without the compiler
// stopping here and forcing a decision about what an athlete or parent is
// shown as its justification. That is a deliberate speed bump on a
// minor-facing disclosure surface, so if a future rule has no rollup
// evidence, map it to [] as these two are -- do not loosen the type.

const DETECTED_FROM_RULE_PREFIX = 'deterministic_rule:';

/**
 * The exact AthletePerformanceRow fields each deterministic rule reads (see
 * deriveSuggestions above) -- restated here as an explicit allowlist so the
 * athlete/parent-facing justification slice has one place to import from
 * rather than a second, possibly-drifting list of "safe" fields.
 */
export const RULE_JUSTIFICATION_FIELDS: Readonly<Record<SuggestionRule, readonly (keyof AthletePerformanceRow)[]>> = {
  readiness_falling: [
    'avg_readiness',
    'readiness_count',
    'readiness_early_avg',
    'readiness_late_avg',
    'readiness_early_count',
    'readiness_late_count',
  ],
  training_days_dropping: ['training_days', 'training_days_early', 'training_days_late'],
  assignments_stalled: [],
  transfer_check_failed: [],
  competition_loss_unresolved: [],
};

/** Extracts the rule name from a gap's stored detected_from, or null when the
 * gap was not produced by a confirmed deterministic suggestion (manual gaps,
 * or any future detected_from vocabulary this module does not recognise). */
export function ruleFromDetectedFrom(detectedFrom: string | null | undefined): SuggestionRule | null {
  if (!detectedFrom || !detectedFrom.startsWith(DETECTED_FROM_RULE_PREFIX)) return null;
  const rule = detectedFrom.slice(DETECTED_FROM_RULE_PREFIX.length);
  return rule in RULE_JUSTIFICATION_FIELDS ? (rule as SuggestionRule) : null;
}

export interface GapJustificationSource {
  gap_id: string;
  detected_from: string | null;
}

export interface GapJustification {
  gap_id: string;
  rule: SuggestionRule;
  fields: Partial<Record<keyof AthletePerformanceRow, number | null>>;
}

/**
 * Pure projection: given the one performance row for an athlete and the
 * detection source of each of their gaps, returns the allowed-fields-only
 * justification for every rule-generated gap. Gaps with no rule (manual), an
 * unrecognised rule, or an empty field list (assignments_stalled) contribute
 * nothing. Exported separately from getGapJustifications below so the
 * allowlisting is testable with no database, the same split
 * deriveSuggestions/getGapSuggestions already uses.
 */
export function buildGapJustifications(
  row: AthletePerformanceRow | undefined,
  gaps: readonly GapJustificationSource[],
): GapJustification[] {
  if (!row) return [];

  const justifications: GapJustification[] = [];
  for (const gap of gaps) {
    const rule = ruleFromDetectedFrom(gap.detected_from);
    if (!rule) continue;
    const allowedFields = RULE_JUSTIFICATION_FIELDS[rule];
    if (allowedFields.length === 0) continue;

    const fields: Partial<Record<keyof AthletePerformanceRow, number | null>> = {};
    for (const field of allowedFields) {
      fields[field] = row[field] as number | null;
    }
    justifications.push({ gap_id: gap.gap_id, rule, fields });
  }
  return justifications;
}

/**
 * DB-calling wrapper: one rollup fetch for the single athlete (default
 * window, same as the suggestion engine reads), projected down through
 * buildGapJustifications. Athlete-scoped by construction -- the caller
 * supplies exactly one athlete_id, already authorised by
 * assertActorCanAccessAthlete before this runs.
 */
export async function getGapJustifications(
  organizationId: string,
  athleteId: string,
  gaps: readonly GapJustificationSource[],
): Promise<GapJustification[]> {
  // Skip the rollup fetch entirely when nothing in this athlete's gaps could
  // ever produce a justification -- an athlete whose gaps are all manual
  // observations (the common case) costs this endpoint one query, not six.
  const hasEligibleGap = gaps.some((gap) => {
    const rule = ruleFromDetectedFrom(gap.detected_from);
    return rule !== null && RULE_JUSTIFICATION_FIELDS[rule].length > 0;
  });
  if (!hasEligibleGap) return [];

  const [row] = await getPerformanceRollup(organizationId, [athleteId], PERFORMANCE_WINDOW_DAYS_DEFAULT);
  return buildGapJustifications(row, gaps);
}
