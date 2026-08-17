import { query } from './db';
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
// Thresholds are named constants pinned by tests. Where an equivalent
// threshold already exists elsewhere it is IMPORTED, not restated, so the
// two rules can never drift apart (attendance reuses the gap-suggestion
// constants; the RED band reuses the readiness board's).
//
// Item 6 (added later, capability-network audit finding): open safety
// escalations and filed compliance violations for the coach's own roster.
// Before this, the digest queried four sources live and never these two --
// an athlete under active safety review could show nothing here, on the one
// screen built to tell a coach what needs their eyes today. Same live-query,
// no-storage shape as every other item; "open" mirrors each register's own
// unresolved states (escalations: open/acknowledged; violations: anything
// short of resolved/dismissed).

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

export interface CoachIntelligenceDigest {
  stalled_gaps: Array<{ athlete_id: string; athlete_name: string; gap_type: string; gap_description: string; days_open: number }>;
  readiness_concerns: Array<{ athlete_id: string; athlete_name: string; red_days: number }>;
  fading_attendance: Array<{ athlete_id: string; athlete_name: string; training_days_early: number; training_days_late: number }>;
  unreviewed_sessions: Array<{ athlete_id: string; athlete_name: string; session_id: string; session_date: string; days_waiting: number }>;
  expiring_holds: Array<{ athlete_id: string; athlete_name: string; hold_id: string; expires_at: string }>;
  open_safety_items: Array<{
    athlete_id: string;
    athlete_name: string;
    kind: 'escalation' | 'violation';
    source_id: string;
    severity: string;
    reason: string;
    status: string;
    created_at: string;
  }>;
}

export async function getCoachIntelligence(
  organizationId: string,
  athleteIds: readonly string[],
): Promise<CoachIntelligenceDigest> {
  if (athleteIds.length === 0) {
    return {
      stalled_gaps: [], readiness_concerns: [], fading_attendance: [], unreviewed_sessions: [], expiring_holds: [],
      open_safety_items: [],
    };
  }
  const ids = [...athleteIds];

  const [stalledGaps, redDays, rollup, unreviewed, holds, safetyItems, names] = await Promise.all([
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
    // 6. Open safety escalations and unresolved compliance violations,
    // combined into one ledger the same way the two registers are already
    // read elsewhere (board summary, escalation ladder) -- just scoped to
    // this coach's own roster instead of org-wide.
    query<{
      athlete_id: string; kind: 'escalation' | 'violation'; source_id: string;
      severity: string; reason: string; status: string; created_at: string;
    }>(
      `select athlete_id, 'escalation'::text as kind, escalation_id as source_id,
              severity, reason, status, created_at::text as created_at
       from pilot.safety_escalations
       where organization_id = $1 and athlete_id = any($2::text[])
         and status in ('open', 'acknowledged')
       union all
       select v.athlete_id, 'violation'::text as kind, v.violation_id as source_id,
              v.severity, coalesce(r.rule_name, 'Compliance violation') as reason, v.status, v.created_at::text as created_at
       from pilot.compliance_violations v
       left join pilot.compliance_rules r
         on r.organization_id = v.organization_id and r.rule_id = v.rule_id
       where v.organization_id = $1 and v.athlete_id = any($2::text[])
         and v.status not in ('resolved', 'dismissed')
       order by created_at asc`,
      [organizationId, ids],
    ),
    // Names for item 3 and item 6 (both queries return numbers/ids only). An
    // id with no athlete row cannot happen for ids that came from the roster
    // read, but the fallback renders the id rather than inventing a name.
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

  return {
    stalled_gaps: stalledGaps,
    readiness_concerns: redDays,
    fading_attendance: fading,
    unreviewed_sessions: unreviewed,
    expiring_holds: holds,
    open_safety_items: safetyItems.map((row) => ({
      ...row,
      athlete_name: nameById.get(row.athlete_id) ?? row.athlete_id,
    })),
  };
}
