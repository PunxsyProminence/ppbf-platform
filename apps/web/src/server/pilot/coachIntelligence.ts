import { COMPLIANCE_VIOLATION_OPEN_STATUSES, type ComplianceViolation } from './compliance';
import { query } from './db';
import {
  listEscalations,
  type SafetyEscalationSeverity,
  type SafetyEscalationSourceType,
  type SafetyEscalationStatus,
} from './escalationLadder';
import { getPerformanceRollup } from './performanceAnalytics';
import { TRAINING_DAYS_MIN_EARLY, TRAINING_DAYS_DROP_RATIO } from './progressionSuggestions';
import { READINESS_YELLOW_MIN } from './readinessBoard';

// Coach Intelligence v1 (register module 111) -- the definition the owner
// approved 2026-08-16, verbatim: five deterministic, read-only observations
// about a coach's OWN athletes, each a stored fact plus a named threshold.
// No ML, no scores, no predictions about a child's potential, nothing
// athlete- or parent-visible, nothing automatic. It is the ledger organized
// by urgency; the coach decides what any of it means.
//
// Items 6 and 7 (the two safety registers) were added afterwards to close a
// defect, not to widen the definition. The digest read progression, readiness,
// attendance, sessions, and holds -- and nothing at all from
// pilot.safety_escalations or pilot.compliance_violations. An athlete with an
// OPEN escalation filed against them, or a filed compliance violation,
// produced ZERO items, so the page rendered its "Nothing needs your eyes"
// empty state on the one surface built to catch exactly that. A digest that
// is silent about the two most urgent registers in the app is worse than no
// digest: it converts "I have not looked" into "I looked and it was fine".
// Both new items are the same shape as the other five -- a live query, no
// storage, no judgment about what the record means.
//
// Thresholds are named constants pinned by tests. Where an equivalent
// threshold already exists elsewhere it is IMPORTED, not restated, so the
// two rules can never drift apart (attendance reuses the gap-suggestion
// constants; the RED band reuses the readiness board's; what counts as a
// still-open compliance violation reuses compliance.ts's lifecycle).

/** Item 1: a gap identified this long ago with no drill ever assigned. */
export const STALLED_GAP_DAYS = 14;
/** Item 2: this many RED check-in days inside the window is a concern. */
export const READINESS_RED_DAYS = 3;
export const READINESS_RED_WINDOW_DAYS = 7;
/** Item 3 reuses TRAINING_DAYS_MIN_EARLY / TRAINING_DAYS_DROP_RATIO. */
export const ATTENDANCE_WINDOW_DAYS = 28;
/** Item 4: a completed session unreviewed for this long. */
export const UNREVIEWED_SESSION_DAYS = 7;
/** Item 5: an active hold expiring inside this window needs a decision. */
export const HOLD_EXPIRY_DAYS = 14;
/**
 * Item 6: the status an escalation must still be at to reach the digest.
 * There is deliberately no day threshold and no severity floor here -- an
 * escalation only exists because something already crossed a line in the
 * capability that filed it (#194 escalates 'high' and 'critical' near misses,
 * every pain report, every safety-gate flag), so re-judging it against a
 * second threshold here would be this module inventing safety doctrine it has
 * no business inventing. Age is not a filter either: a critical escalation
 * filed an hour ago is exactly what a morning read is for.
 *
 * 'acknowledged' is not included, and that is a real choice, not an omission
 * -- see the README next to the route for what it costs.
 */
export const ESCALATION_DIGEST_STATUS: SafetyEscalationStatus = 'open';

/**
 * The one escalation source_type item 6 does NOT report, because item 7
 * reports the same events from their authoritative side. Named rather than
 * inlined so the dedup is greppable from both directions: anyone widening
 * item 7, or wondering why a compliance escalation is missing from item 6,
 * lands here. See the filter at the mapping site for the full argument.
 */
export const ESCALATION_SOURCE_OWNED_BY_ITEM_7: SafetyEscalationSourceType = 'compliance_violation';
// Item 7 states no threshold of its own: it reuses
// COMPLIANCE_VIOLATION_OPEN_STATUSES from compliance.ts.

export interface CoachIntelligenceDigest {
  // The two safety registers are declared first because this object's key
  // order is the only ordering the digest carries, and a safeguarding item
  // must never be a scroll below "attendance fading". The page renders its
  // own section order and enforces the same precedence.
  open_safety_escalations: Array<{
    athlete_id: string;
    athlete_name: string;
    escalation_id: string;
    source_type: SafetyEscalationSourceType;
    severity: SafetyEscalationSeverity;
    reason: string;
    created_at: string;
  }>;
  open_compliance_violations: Array<{
    athlete_id: string;
    athlete_name: string;
    violation_id: string;
    rule_id: string;
    rule_name: string;
    severity: string;
    status: ComplianceViolation['status'];
    days_open: number;
  }>;
  stalled_gaps: Array<{ athlete_id: string; athlete_name: string; gap_type: string; gap_description: string; days_open: number }>;
  readiness_concerns: Array<{ athlete_id: string; athlete_name: string; red_days: number }>;
  fading_attendance: Array<{ athlete_id: string; athlete_name: string; training_days_early: number; training_days_late: number }>;
  unreviewed_sessions: Array<{ athlete_id: string; athlete_name: string; session_id: string; session_date: string; days_waiting: number }>;
  expiring_holds: Array<{ athlete_id: string; athlete_name: string; hold_id: string; expires_at: string }>;
}

export async function getCoachIntelligence(
  organizationId: string,
  athleteIds: readonly string[],
): Promise<CoachIntelligenceDigest> {
  if (athleteIds.length === 0) {
    return {
      open_safety_escalations: [], open_compliance_violations: [],
      stalled_gaps: [], readiness_concerns: [], fading_attendance: [], unreviewed_sessions: [], expiring_holds: [],
    };
  }
  const ids = [...athleteIds];

  const [stalledGaps, redDays, rollup, unreviewed, holds, escalations, violations, names] = await Promise.all([
    // 1. Gaps identified STALLED_GAP_DAYS+ ago that never got an assignment.
    query<{ athlete_id: string; athlete_name: string; gap_type: string; gap_description: string; days_open: number }>(
      `select g.athlete_id, a.full_name as athlete_name, g.gap_type, g.gap_description,
              (now()::date - g.created_at::date)::int as days_open
       from pilot.progression_gaps g
       join pilot.athletes a on a.organization_id = g.organization_id and a.athlete_id = g.athlete_id
       where g.organization_id = $1 and g.athlete_id = any($2::text[])
         and g.status = 'identified'
         and g.created_at <= now() - make_interval(days => $3)
         and not exists (
           select 1 from pilot.drill_assignments da
           where da.organization_id = g.organization_id and da.gap_id = g.gap_id
         )
       order by g.created_at asc`,
      [organizationId, ids, STALLED_GAP_DAYS],
    ),
    // 2. Distinct days in the window whose LATEST check-in landed RED.
    query<{ athlete_id: string; athlete_name: string; red_days: number }>(
      `with daily_latest as (
         select distinct on (r.athlete_id, r.measured_at::date)
           r.athlete_id, r.measured_at::date as day, r.score
         from pilot.readiness r
         where r.organization_id = $1 and r.athlete_id = any($2::text[])
           and r.measured_at >= now() - make_interval(days => $3)
         order by r.athlete_id, r.measured_at::date, r.measured_at desc
       )
       select d.athlete_id, a.full_name as athlete_name, count(*)::int as red_days
       from daily_latest d
       join pilot.athletes a on a.organization_id = $1 and a.athlete_id = d.athlete_id
       where d.score < $4
       group by d.athlete_id, a.full_name
       having count(*) >= $5`,
      [organizationId, ids, READINESS_RED_WINDOW_DAYS, READINESS_YELLOW_MIN, READINESS_RED_DAYS],
    ),
    // 3. The gap-suggestion engine's own attendance halves, same constants.
    getPerformanceRollup(organizationId, ids, ATTENDANCE_WINDOW_DAYS),
    // 4. Completed sessions with no review after UNREVIEWED_SESSION_DAYS.
    query<{ athlete_id: string; athlete_name: string; session_id: string; session_date: string; days_waiting: number }>(
      `select s.athlete_id, a.full_name as athlete_name, s.session_id,
              s.date::text as session_date,
              (now()::date - s.date)::int as days_waiting
       from pilot.sessions s
       join pilot.athletes a on a.organization_id = s.organization_id and a.athlete_id = s.athlete_id
       where s.organization_id = $1 and s.athlete_id = any($2::text[])
         and s.completed_flag = true
         and s.date <= now()::date - $3
         and not exists (
           select 1 from pilot.coach_reviews cr
           where cr.organization_id = s.organization_id and cr.session_id = s.session_id
         )
       order by s.date asc`,
      [organizationId, ids, UNREVIEWED_SESSION_DAYS],
    ),
    // 5. Active holds whose own clock runs out inside the window.
    query<{ athlete_id: string; athlete_name: string; hold_id: string; expires_at: string }>(
      `select h.athlete_id, a.full_name as athlete_name, h.hold_id, h.expires_at::text as expires_at
       from pilot.training_holds h
       join pilot.athletes a on a.organization_id = h.organization_id and a.athlete_id = h.athlete_id
       where h.organization_id = $1 and h.athlete_id = any($2::text[])
         and h.status = 'active' and h.expires_at is not null
         and h.expires_at <= now() + make_interval(days => $3)
       order by h.expires_at asc`,
      [organizationId, ids, HOLD_EXPIRY_DAYS],
    ),
    // 6. Open safety escalations (#194) filed against this coach's athletes.
    //
    // Delegated to listEscalations for the same reason item 3 delegates the
    // attendance halves to getPerformanceRollup: the escalation ladder owns
    // what an escalation IS -- its severity-first ordering, its status
    // vocabulary, and the athlete_voice exclusion below -- and a second copy
    // of that SQL living here would be a second thing to keep in step with a
    // safeguarding capability. Its athleteIds filter is the same
    // coach-roster scoping the queries above apply by hand, and its
    // organizationId argument the same org scoping.
    //
    // excludeAthleteVoice is not optional and is not conditional. An
    // 'athlete_voice' escalation exists because a child typed something into
    // the feedback box, and its mere presence on a coach's list -- however
    // non-disclosing the reason text -- tells that coach the child said
    // something, when the coach may be exactly who the child is disclosing
    // about (escalationLadder.ts, EscalationListFilters). This function is
    // handed an id list and an org, never a role, and the route behind it
    // serves coaches AND admins through this one call, so there is nothing
    // here to branch on: it excludes them unconditionally and fails closed.
    // An admin reads athlete_voice rows on /api/pilot/escalations, which
    // does know the caller's role and does branch on it.
    listEscalations(organizationId, {
      status: ESCALATION_DIGEST_STATUS,
      athleteIds: ids,
      excludeAthleteVoice: true,
    }),
    // 7. Compliance violations still open against this coach's athletes.
    //
    // Queried here in the shape items 1/4/5 use, rather than delegated,
    // because the compliance capability has no read that fits: its
    // getOrganizationViolations filters ONE athlete_id or ONE coach account
    // and caps at 50 rows, while this digest is handed an already-scoped id
    // array (and a truncated safety list is precisely the failure this item
    // exists to fix). What "still open" MEANS is imported all the same --
    // COMPLIANCE_VIOLATION_OPEN_STATUSES from the module that owns the
    // lifecycle -- so the digest cannot drift into calling a dismissed
    // violation live.
    //
    // Unlike item 6 this one keeps 'acknowledged' rows. Every compliance
    // transition (acknowledge / escalate / resolve / dismiss) is an admin
    // action, so 'acknowledged' means an ADMIN has seen it and says nothing
    // about whether the athlete's own coach has; it stays on the coach's
    // morning read until the violation is actually closed out.
    //
    // The rule join is a LEFT join and the name falls back to the rule_id: a
    // missing or cross-organization pilot.compliance_rules row must never
    // drop a violation out of a safety list, which an inner join would do
    // silently. Same doctrine as the name fallback below -- render the id
    // rather than invent a label, and never lose the row.
    query<{
      athlete_id: string; athlete_name: string; violation_id: string; rule_id: string;
      rule_name: string; severity: string; status: ComplianceViolation['status']; days_open: number;
    }>(
      `select v.athlete_id, a.full_name as athlete_name, v.violation_id, v.rule_id,
              coalesce(r.rule_name, v.rule_id) as rule_name,
              v.severity, v.status,
              (now()::date - v.created_at::date)::int as days_open
       from pilot.compliance_violations v
       join pilot.athletes a on a.organization_id = v.organization_id and a.athlete_id = v.athlete_id
       left join pilot.compliance_rules r on r.organization_id = v.organization_id and r.rule_id = v.rule_id
       where v.organization_id = $1 and v.athlete_id = any($2::text[])
         and v.status = any($3::text[])
       order by v.created_at asc`,
      [organizationId, ids, [...COMPLIANCE_VIOLATION_OPEN_STATUSES]],
    ),
    // Names for items 3 and 6 (the rollup is numbers only; the escalation
    // rows carry an athlete_id and no name). An id with no athlete row
    // cannot happen for ids that came from the roster read, but the fallback
    // renders the id rather than inventing a name.
    query<{ athlete_id: string; full_name: string }>(
      `select athlete_id, full_name from pilot.athletes
       where organization_id = $1 and athlete_id = any($2::text[])`,
      [organizationId, ids],
    ),
  ]);

  const nameById = new Map(names.map((row) => [row.athlete_id, row.full_name]));

  const fading = rollup
    .filter((row) =>
      row.training_days_early >= TRAINING_DAYS_MIN_EARLY
      && row.training_days_late < row.training_days_early * TRAINING_DAYS_DROP_RATIO)
    .map((row) => ({
      athlete_id: row.athlete_id,
      athlete_name: nameById.get(row.athlete_id) ?? row.athlete_id,
      training_days_early: row.training_days_early,
      training_days_late: row.training_days_late,
    }));

  // The escalation rows are narrowed to the digest's item shape rather than
  // passed through whole: resolution notes, acknowledging accounts, and the
  // metadata blob belong to the escalation surface that can act on them, and
  // a read-only digest has no reason to carry them into a second place.
  // listEscalations' severity-then-newest ordering is preserved as-is.
  const openEscalations = escalations
    // Items 6 and 7 would otherwise report the SAME compliance event twice.
    //
    // compliance.ts#createComplianceViolation files an escalation with
    // source_type 'compliance_violation' on the same transaction as the
    // violation insert, whenever the violated rule's escalation_level maps to
    // a supported target role. So for most rules a single violation now
    // produces a row in BOTH registers this digest reads, and a coach would
    // open the Morning Read to find one incident sitting in two sections
    // under two different vocabularies.
    //
    // Item 7 is the side that survives, for two reasons. It reads the
    // authoritative record -- the violation itself, with its rule name, its
    // own status lifecycle and its days-open count -- rather than the
    // notification filed about it. And its coverage is strictly WIDER: a rule
    // whose escalation_level is 'board' or 'parent' produces no escalation at
    // all (escalationLadder.ts excludes both target roles by design), so
    // those violations exist ONLY in item 7. Dropping item 7 to dedupe would
    // have silently lost them; dropping the compliance-derived escalations
    // from item 6 loses nothing, because every one of them is a strict subset
    // of what item 7 already lists.
    //
    // Filtered here rather than by extending EscalationListFilters: this is
    // one caller's de-duplication concern, and escalationLadder.ts is a
    // safeguarding capability that should not grow a filter for it. Every
    // other source_type -- near_miss, pain_report, safety_gate_evaluation,
    // repeated_pattern, training_hold, incident, video_scan -- still reaches
    // item 6, and athlete_voice is still excluded upstream, unconditionally.
    .filter((row) => row.source_type !== ESCALATION_SOURCE_OWNED_BY_ITEM_7)
    .map((row) => ({
      athlete_id: row.athlete_id,
      athlete_name: nameById.get(row.athlete_id) ?? row.athlete_id,
      escalation_id: row.escalation_id,
      source_type: row.source_type,
      severity: row.severity,
      reason: row.reason,
      created_at: row.created_at,
    }));

  return {
    open_safety_escalations: openEscalations,
    open_compliance_violations: violations,
    stalled_gaps: stalledGaps,
    readiness_concerns: redDays,
    fading_attendance: fading,
    unreviewed_sessions: unreviewed,
    expiring_holds: holds,
  };
}
