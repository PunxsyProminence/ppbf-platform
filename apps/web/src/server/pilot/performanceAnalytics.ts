import { query } from './db';

// Read-only performance rollup for the coach/admin analytics surface.
//
// Every number here is an aggregate over tables that already exist and are
// already written by shipped flows -- pilot.sessions (session logs with RPE),
// pilot.readiness (check-in scores), pilot.activity_log (go-forward
// attendance evidence per docs/current/ACTIVE_WORK.md), and the progression
// tables. This module issues no DDL and writes nothing.
//
// Attendance deliberately reads ONLY pilot.activity_log's boxing_training
// rows. Three attendance-shaped tables exist (pilot.attendance,
// pilot.scheduler_attendance, pilot.activity_log) and activityLog.ts's own
// header says a human decides which source wins on conflict. This surface
// does not adjudicate that: it reports the go-forward evidence stream and
// labels it "training days", not "attendance %", so it cannot contradict the
// scheduler's own attendance reporting (attendanceReporting.ts) which serves
// a different question from a different table.

export interface AthletePerformanceRow {
  athlete_id: string;
  sessions_total: number;
  sessions_completed: number;
  avg_rpe: number | null;
  training_days: number;
  readiness_count: number;
  avg_readiness: number | null;
  // Mean readiness in the older half vs the newer half of the window, so the
  // page can show direction without pretending to be a statistical claim.
  readiness_early_avg: number | null;
  readiness_late_avg: number | null;
  open_gaps: number;
  active_assignments: number;
  avg_assignment_completion: number | null;
}

interface SessionsAgg {
  athlete_id: string;
  sessions_total: number;
  sessions_completed: number;
  avg_rpe: number | null;
}

interface ReadinessAgg {
  athlete_id: string;
  readiness_count: number;
  avg_readiness: number | null;
  readiness_early_avg: number | null;
  readiness_late_avg: number | null;
}

interface TrainingDaysAgg {
  athlete_id: string;
  training_days: number;
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
              avg(rpe)::float8 as avg_rpe
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
              (avg(score) filter (where measured_at >= $4::timestamptz))::float8 as readiness_late_avg
       from pilot.readiness
       where organization_id = $1 and athlete_id = any($2::text[]) and measured_at >= $3::timestamptz
       group by athlete_id`,
      [organizationId, ids, cutoffIso, midpointIso],
    ),
    query<TrainingDaysAgg>(
      `select athlete_id,
              count(distinct occurred_on)::int as training_days
       from pilot.activity_log
       where organization_id = $1 and athlete_id = any($2::text[])
         and activity_domain = 'boxing_training' and attendance_status = 'present'
         and occurred_on >= $3::date
       group by athlete_id`,
      [organizationId, ids, cutoffDate],
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
    training_days: byTraining.get(athleteId)?.training_days ?? 0,
    readiness_count: byReadiness.get(athleteId)?.readiness_count ?? 0,
    avg_readiness: byReadiness.get(athleteId)?.avg_readiness ?? null,
    readiness_early_avg: byReadiness.get(athleteId)?.readiness_early_avg ?? null,
    readiness_late_avg: byReadiness.get(athleteId)?.readiness_late_avg ?? null,
    open_gaps: byGaps.get(athleteId)?.open_gaps ?? 0,
    active_assignments: byAssignments.get(athleteId)?.active_assignments ?? 0,
    avg_assignment_completion: byAssignments.get(athleteId)?.avg_assignment_completion ?? null,
  }));
}
