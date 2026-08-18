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
// threshold already exists elsewhere it is IMPORTED, not restated
// (attendance reuses the gap-suggestion constants; the RED band reuses the
// readiness board's).
//
// Sharing the constant is NOT by itself an invariant. The comparison built
// around it is written out separately in each module, so the two attendance
// rules can still drift on their boundary -- and did: this digest tested
// `late < early * RATIO` while the suggestion engine tested `<=`, so an
// athlete whose attendance exactly halved (early 4, late 2) raised a
// progression suggestion and stayed silent here. A coach was told nothing
// about a child the system had already flagged.
//
// What actually holds the two together is a test, not the shared constant:
// 'the fading filter agrees with the suggestion engine on every boundary'
// in coachIntelligence.test.ts runs the same rollup rows through
// deriveSuggestions and through this digest and fails if either side moves.
// A change to either comparison must keep that test green.

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
}

export async function getCoachIntelligence(
  organizationId: string,
  athleteIds: readonly string[],
): Promise<CoachIntelligenceDigest> {
  if (athleteIds.length === 0) {
    return { stalled_gaps: [], readiness_concerns: [], fading_attendance: [], unreviewed_sessions: [], expiring_holds: [] };
  }
  const ids = [...athleteIds];

  const [stalledGaps, redDays, rollup, unreviewed, holds, names] = await Promise.all([
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
      // <=, matching rule 2 in progressionSuggestions.ts: a habit the newer
      // half has "lost at least half of" includes losing exactly half.
      && row.training_days_late <= row.training_days_early * TRAINING_DAYS_DROP_RATIO)
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
  };
}
