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
  open_safety_escalations: Array<{ athlete_id: string; athlete_name: string; escalation_id: string; source_type: string; severity: string; reason: string; created_at: string }>;
  open_compliance_violations: Array<{ athlete_id: string; athlete_name: string; violation_id: string; severity: string; status: string; created_at: string }>;
}

const EMPTY_DIGEST: CoachIntelligenceDigest = {
  stalled_gaps: [], readiness_concerns: [], fading_attendance: [], unreviewed_sessions: [], expiring_holds: [],
  open_safety_escalations: [], open_compliance_violations: [],
};

export interface GetCoachIntelligenceOptions {
  /** Same rule as the escalations route: an athlete_voice row exists because
   * a child typed something into the feedback box, and the athlete's own
   * coach may be exactly who they are disclosing about. Coach reads set
   * this; admin reads leave it unset. */
  excludeAthleteVoice?: boolean;
}

export async function getCoachIntelligence(
  organizationId: string,
  athleteIds: readonly string[],
  options: GetCoachIntelligenceOptions = {},
): Promise<CoachIntelligenceDigest> {
  if (athleteIds.length === 0) {
    return EMPTY_DIGEST;
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
    // 6. Open safety escalations -- the highest-severity blind spot this
    // digest had: every other item is a routine coaching signal, this one is
    // the platform's own red-flag ladder. excludeAthleteVoice mirrors the
    // /api/pilot/escalations route's coach-scoped read exactly.
    query<{ athlete_id: string; athlete_name: string; escalation_id: string; source_type: string; severity: string; reason: string; created_at: string }>(
      `select e.athlete_id, a.full_name as athlete_name, e.escalation_id, e.source_type, e.severity, e.reason,
              e.created_at::text as created_at
       from pilot.safety_escalations e
       join pilot.athletes a on a.organization_id = e.organization_id and a.athlete_id = e.athlete_id
       where e.organization_id = $1 and e.athlete_id = any($2::text[])
         and e.status = 'open'
         and ($3::boolean is not true or e.source_type <> 'athlete_voice')
       order by case e.severity when 'critical' then 0 when 'high' then 1 when 'moderate' then 2 else 3 end asc,
                e.created_at asc`,
      [organizationId, ids, options.excludeAthleteVoice ?? null],
    ),
    // 7. Open compliance violations (not yet resolved or dismissed) -- the
    // digest's other safety-critical blind spot, same reasoning as escalations.
    query<{ athlete_id: string; athlete_name: string; violation_id: string; severity: string; status: string; created_at: string }>(
      `select v.athlete_id, a.full_name as athlete_name, v.violation_id, v.severity, v.status,
              v.created_at::text as created_at
       from pilot.compliance_violations v
       join pilot.athletes a on a.organization_id = v.organization_id and a.athlete_id = v.athlete_id
       where v.organization_id = $1 and v.athlete_id = any($2::text[])
         and v.status not in ('resolved', 'dismissed')
       order by case v.severity when 'critical' then 1 when 'high' then 2 when 'medium' then 3 when 'low' then 4 else 5 end asc,
                v.created_at asc`,
      [organizationId, ids],
    ),
    // Names for item 3 (the rollup is numbers only). An id with no athlete
    // row cannot happen for ids that came from the roster read, but the
    // fallback renders the id rather than inventing a name.
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
    open_safety_escalations: escalations,
    open_compliance_violations: violations,
  };
}
