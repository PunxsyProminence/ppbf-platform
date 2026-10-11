import type { SessionRpeMethod } from './contracts';
import { gymDayIso } from '../../lib/gymTime';
import { query } from './db';
import {
  READINESS_VALUE_MAX,
  READINESS_VALUE_MIN,
  readinessValidatedScopeSql,
} from './readinessProvenance';

/**
 * The one session-RPE provenance that means "the athlete rated the session
 * they just finished". Typed as SessionRpeMethod rather than written as a
 * bare string in the SQL below, so a typo is a typecheck failure instead of a
 * predicate that silently matches nothing and averages an empty set to null --
 * which would look exactly like "nobody has rated a session yet".
 *
 * Declared here rather than added to contracts.ts: this slice does not own
 * that file, and the type it exports is already the authority.
 */
const SESSION_RPE_SELF_REPORT: SessionRpeMethod = 'athlete_post_session_self_report';

// Read-only performance rollup for the coach/admin analytics surface.
//
// Every number here is an aggregate over tables that already exist and are
// already written by shipped flows -- pilot.sessions (session logs with RPE),
// pilot.readiness (check-in scores), pilot.activity_log (go-forward
// attendance evidence per docs/current/ACTIVE_WORK.md), and the progression
// tables. This module issues no DDL and writes nothing.
//
// TRAINING DAYS read pilot.attendance_reconciled (attendancePrecedence.ts's
// view), not pilot.activity_log. OD-2026-10-07-010 Q9: coach screens count
// training days from the class register. The view collapses every attendance
// source to one row per athlete-day in the gym's calendar, so a day with two
// classes or two source rows is one day. This is a day count labelled
// "training days", not an attendance rate: it has no denominator.
// Source precedence is the view's own and is not restated or adjudicated here.

export interface AthletePerformanceRow {
  athlete_id: string;
  sessions_total: number;
  sessions_completed: number;
  avg_rpe: number | null;
  // Session load = session RPE x minutes trained (Foster 2001), averaged over
  // the sessions in the window that carry BOTH an athlete post-session RPE and
  // the athlete's minutes. Computed here, never stored, and NOT validated for
  // boxing (pilot_slice_postgres_sparring_exposure_and_load_migration.sql), so
  // the page labels it as such. No flag, score or threshold reads it here.
  avg_session_load: number | null;
  // How many sessions that average is over, so "no load yet" and "load from
  // one session" are visibly different.
  session_load_count: number;
  // Distinct gym-local days with a PRESENT mark in the reconciled register.
  training_days: number;
  // Distinct gym-local days in the window with ANY mark (present, absent or
  // excused). 0 = no register for the window; >0 with training_days 0 is a
  // verified zero.
  training_days_recorded: number;
  // Distinct training days in the older half vs the newer half of the window,
  // for the deterministic consistency rule in progressionSuggestions.ts.
  training_days_early: number;
  training_days_late: number;
  // Days with ANY mark in each half (present, absent or excused). The drop
  // rules need late > 0: with no register in the newer half, 0 present days
  // is "nobody took the register", not "the athlete stopped coming".
  training_days_recorded_early: number;
  training_days_recorded_late: number;
  readiness_count: number;
  avg_readiness: number | null;
  // Mean readiness in the older half vs the newer half of the window, so the
  // page can show direction without pretending to be a statistical claim.
  // The per-half counts exist so a rule can refuse to read a direction into
  // halves that are too thin to carry one.
  readiness_early_avg: number | null;
  readiness_late_avg: number | null;
  readiness_early_count: number;
  readiness_late_count: number;
  open_gaps: number;
  active_assignments: number;
  avg_assignment_completion: number | null;
}

interface SessionsAgg {
  athlete_id: string;
  sessions_total: number;
  sessions_completed: number;
  avg_rpe: number | null;
  avg_session_load: number | null;
  session_load_count: number;
}

interface ReadinessAgg {
  athlete_id: string;
  readiness_count: number;
  avg_readiness: number | null;
  readiness_early_avg: number | null;
  readiness_late_avg: number | null;
  readiness_early_count: number;
  readiness_late_count: number;
}

interface TrainingDaysAgg {
  athlete_id: string;
  training_days: number;
  training_days_recorded: number;
  training_days_recorded_early: number;
  training_days_recorded_late: number;
  training_days_early: number;
  training_days_late: number;
}

interface GapsAgg {
  athlete_id: string;
  open_gaps: number;
}

interface AssignmentsAgg {
  athlete_id: string;
  active_assignments: number;
  avg_assignment_completion: number | null;
}

export const PERFORMANCE_WINDOW_DAYS_DEFAULT = 28;
export const PERFORMANCE_WINDOW_DAYS_MAX = 365;

export function clampWindowDays(raw: unknown): number {
  // Number(null) and Number('') are 0, which would clamp to the floor
  // instead of falling back -- an absent parameter must mean the default.
  if (raw == null || raw === '') return PERFORMANCE_WINDOW_DAYS_DEFAULT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return PERFORMANCE_WINDOW_DAYS_DEFAULT;
  return Math.min(Math.max(Math.trunc(parsed), 1), PERFORMANCE_WINDOW_DAYS_MAX);
}

export async function getPerformanceRollup(
  organizationId: string,
  athleteIds: readonly string[],
  windowDays: number,
): Promise<AthletePerformanceRow[]> {
  if (athleteIds.length === 0) return [];

  const now = Date.now();
  const cutoff = new Date(now - windowDays * 24 * 60 * 60 * 1000);
  const midpoint = new Date(now - (windowDays / 2) * 24 * 60 * 60 * 1000);
  const cutoffIso = cutoff.toISOString();
  const midpointIso = midpoint.toISOString();
  const cutoffDate = cutoffIso.slice(0, 10);
  const ids = [...athleteIds];

  const [sessionRows, readinessRows, trainingRows, gapRows, assignmentRows] = await Promise.all([
    query<SessionsAgg>(
      `select athlete_id,
              count(*)::int as sessions_total,
              (count(*) filter (where completed_flag))::int as sessions_completed,
              -- ONLY A REAL POST-SESSION SELF-REPORT IS SESSION RPE.
              -- pilot.sessions.rpe holds two different measurements. Before
              -- pilot_slice_postgres_session_rpe_semantics_migration, check-IN
              -- wrote a pre-session READINESS slider into this column; after
              -- it, check-OUT writes the athlete's own answer to "how hard was
              -- the session you just finished". The migration did not and
              -- could not tell them apart retroactively, so it marked every
              -- existing row UNKNOWN and left the numbers where they were.
              --
              -- rpe_method is therefore the only thing that says which
              -- measurement a number IS, and contracts.ts says so outright:
              -- "Read this field only alongside rpe_method." This read did
              -- not, so "Avg RPE" averaged readiness answers together with
              -- effort answers and labelled the result as one measurement --
              -- a number about a child that means neither thing.
              --
              -- The same shape as the readiness query below: the rows stay,
              -- they no longer average. UNKNOWN sessions still count in
              -- sessions_total and sessions_completed, because they are real
              -- sessions -- it is only their RPE that is unusable. And the
              -- method is the authority: nothing here infers that an UNKNOWN
              -- row "looks like" session RPE from completion, date or the
              -- value itself.
              --
              -- avg() over no qualifying rows is null, which is the honest
              -- answer. It must never become 0: "nobody has rated a session"
              -- and "every session was rated nothing" are different facts.
              (avg(rpe) filter (where rpe_method = '${SESSION_RPE_SELF_REPORT}'))::float8 as avg_rpe,
              -- SESSION LOAD, the same provenance rule plus minutes. Only a
              -- real post-session RPE is multiplied: an UNKNOWN row's number
              -- may be a pre-session readiness answer, and readiness x minutes
              -- is not load. A session with no minutes is left out rather
              -- than counted as zero load. Null when nothing qualifies.
              (avg(rpe * duration_minutes) filter (
                where rpe_method = '${SESSION_RPE_SELF_REPORT}'
                  and rpe is not null and duration_minutes is not null
              ))::float8 as avg_session_load,
              (count(*) filter (
                where rpe_method = '${SESSION_RPE_SELF_REPORT}'
                  and rpe is not null and duration_minutes is not null
              ))::int as session_load_count
       from pilot.sessions
       where organization_id = $1 and athlete_id = any($2::text[]) and date >= $3::date
       group by athlete_id`,
      [organizationId, ids, cutoffDate],
    ),
    query<ReadinessAgg>(
      `select athlete_id,
              count(*)::int as readiness_count,
              avg(score)::float8 as avg_readiness,
              (avg(score) filter (where measured_at < $4::timestamptz))::float8 as readiness_early_avg,
              (avg(score) filter (where measured_at >= $4::timestamptz))::float8 as readiness_late_avg,
              (count(*) filter (where measured_at < $4::timestamptz))::int as readiness_early_count,
              (count(*) filter (where measured_at >= $4::timestamptz))::int as readiness_late_count
       from pilot.readiness
       -- MEASUREMENT CLAIMS ONLY. avg_readiness and the early/late halves feed
       -- a "rising"/"falling" badge and a card-urgency rung. Every stored row
       -- is a staff judgement typed at intake against unvalidated defaults, and
       -- averaging those produced a trend line about a child out of opinions
       -- nobody established a method for. Rows stay; they no longer average.
       -- The bounds close the other half: score has no CHECK and both writers
       -- accept any finite number, so one 1e9 row moved the mean arbitrarily.
       where organization_id = $1 and athlete_id = any($2::text[]) and measured_at >= $3::timestamptz
         and ${readinessValidatedScopeSql()}
         and score between ${READINESS_VALUE_MIN} and ${READINESS_VALUE_MAX}
       group by athlete_id`,
      [organizationId, ids, cutoffIso, midpointIso],
    ),
    query<TrainingDaysAgg>(
      `select athlete_id,
              (count(*) filter (where status = 'present'))::int as training_days,
              count(*)::int as training_days_recorded,
              (count(*) filter (where attendance_date < $4::date))::int as training_days_recorded_early,
              (count(*) filter (where attendance_date >= $4::date))::int as training_days_recorded_late,
              (count(*) filter (where status = 'present' and attendance_date < $4::date))::int as training_days_early,
              (count(*) filter (where status = 'present' and attendance_date >= $4::date))::int as training_days_late
       from pilot.attendance_reconciled
       where organization_id = $1 and athlete_id = any($2::text[])
         and attendance_date >= $3::date
       group by athlete_id`,
      [organizationId, ids, gymDayIso(cutoff), gymDayIso(midpoint)],
    ),
    query<GapsAgg>(
      `select athlete_id,
              (count(*) filter (where status in ('identified','assigned','in_progress')))::int as open_gaps
       from pilot.progression_gaps
       where organization_id = $1 and athlete_id = any($2::text[])
       group by athlete_id`,
      [organizationId, ids],
    ),
    query<AssignmentsAgg>(
      `select athlete_id,
              (count(*) filter (where status in ('assigned','in_progress')))::int as active_assignments,
              (avg(completion_percentage) filter (where status <> 'cancelled'))::float8 as avg_assignment_completion
       from pilot.drill_assignments
       where organization_id = $1 and athlete_id = any($2::text[])
       group by athlete_id`,
      [organizationId, ids],
    ),
  ]);

  const bySessions = new Map(sessionRows.map((row) => [row.athlete_id, row]));
  const byReadiness = new Map(readinessRows.map((row) => [row.athlete_id, row]));
  const byTraining = new Map(trainingRows.map((row) => [row.athlete_id, row]));
  const byGaps = new Map(gapRows.map((row) => [row.athlete_id, row]));
  const byAssignments = new Map(assignmentRows.map((row) => [row.athlete_id, row]));

  // One output row per requested athlete, zeros where a source has no rows --
  // an athlete with no data in the window is a fact the page must show, not a
  // row to drop.
  return ids.map((athleteId) => ({
    athlete_id: athleteId,
    sessions_total: bySessions.get(athleteId)?.sessions_total ?? 0,
    sessions_completed: bySessions.get(athleteId)?.sessions_completed ?? 0,
    avg_rpe: bySessions.get(athleteId)?.avg_rpe ?? null,
    avg_session_load: bySessions.get(athleteId)?.avg_session_load ?? null,
    session_load_count: bySessions.get(athleteId)?.session_load_count ?? 0,
    training_days: byTraining.get(athleteId)?.training_days ?? 0,
    training_days_recorded: byTraining.get(athleteId)?.training_days_recorded ?? 0,
    training_days_early: byTraining.get(athleteId)?.training_days_early ?? 0,
    training_days_late: byTraining.get(athleteId)?.training_days_late ?? 0,
    training_days_recorded_early: byTraining.get(athleteId)?.training_days_recorded_early ?? 0,
    training_days_recorded_late: byTraining.get(athleteId)?.training_days_recorded_late ?? 0,
    readiness_count: byReadiness.get(athleteId)?.readiness_count ?? 0,
    avg_readiness: byReadiness.get(athleteId)?.avg_readiness ?? null,
    readiness_early_avg: byReadiness.get(athleteId)?.readiness_early_avg ?? null,
    readiness_late_avg: byReadiness.get(athleteId)?.readiness_late_avg ?? null,
    readiness_early_count: byReadiness.get(athleteId)?.readiness_early_count ?? 0,
    readiness_late_count: byReadiness.get(athleteId)?.readiness_late_count ?? 0,
    open_gaps: byGaps.get(athleteId)?.open_gaps ?? 0,
    active_assignments: byAssignments.get(athleteId)?.active_assignments ?? 0,
    avg_assignment_completion: byAssignments.get(athleteId)?.avg_assignment_completion ?? null,
  }));
}
