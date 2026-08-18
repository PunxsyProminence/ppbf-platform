import { queryOne } from './db';

export const BOARD_MINIMUM_COHORT_SIZE = 5;

export type BoardAggregateStatus =
  | 'available'
  | 'unavailable'
  | 'insufficient_data';

export interface BoardCountMetric {
  status: BoardAggregateStatus;
  count: number | null;
}

export interface BoardRateMetric extends BoardCountMetric {
  completedCount: number | null;
  completionRate: number | null;
}

export interface BoardReviewRateMetric extends BoardCountMetric {
  approvedCount: number | null;
  approvalRate: number | null;
}

export interface BoardSummary {
  scope: 'organization_aggregate';
  minimumCohortSize: number;
  generatedAt: string;
  activeAthletes: BoardCountMetric;
  trainingSessions30Days: BoardRateMetric;
  goalStatusBuckets: {
    active: BoardCountMetric;
    completed: BoardCountMetric;
    other: BoardCountMetric;
  };
  coachReviews30Days: BoardReviewRateMetric;
}

interface BoardSummaryRow {
  active_athlete_count: number;
  session_count: number;
  session_athlete_count: number;
  completed_session_count: number;
  active_goal_count: number;
  active_goal_athlete_count: number;
  completed_goal_count: number;
  completed_goal_athlete_count: number;
  other_goal_count: number;
  other_goal_athlete_count: number;
  review_count: number;
  review_athlete_count: number;
  approved_review_count: number;
}

// Exported so any other board aggregate validates its plain (non-gated)
// counts the same paranoid way -- e.g. an organizational scheduling fact
// like a season or competition count, which is never athlete-linked and so
// never passes through boardCountMetric's k-anonymity gate at all.
export function safeCount(value: unknown): number {
  const count = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('BOARD_SUMMARY_INVALID_AGGREGATE');
  }
  return count;
}

// The single k-anonymity decision for every board-facing aggregate. An empty
// period and a suppressed cohort are different facts and stay distinguishable
// all the way to the screen, so neither can be read as a measured zero.
// Exported so any other board aggregate holds this same floor rather than
// inventing a second, weaker one.
export function boardAggregateStatus(
  recordCount: number,
  participantCount: number,
): BoardAggregateStatus {
  if (recordCount === 0) return 'unavailable';
  if (participantCount < BOARD_MINIMUM_COHORT_SIZE) return 'insufficient_data';
  return 'available';
}

export function boardCountMetric(
  recordCountInput: unknown,
  participantCountInput: unknown,
): BoardCountMetric {
  const recordCount = safeCount(recordCountInput);
  const participantCount = safeCount(participantCountInput);
  const status = boardAggregateStatus(recordCount, participantCount);
  return {
    status,
    count: status === 'available' ? recordCount : null,
  };
}

function rateMetric(
  recordCountInput: unknown,
  participantCountInput: unknown,
  completedCountInput: unknown,
): BoardRateMetric {
  const recordCount = safeCount(recordCountInput);
  const participantCount = safeCount(participantCountInput);
  const completedCount = safeCount(completedCountInput);
  if (completedCount > recordCount) {
    throw new Error('BOARD_SUMMARY_INVALID_AGGREGATE');
  }
  const status = boardAggregateStatus(recordCount, participantCount);
  if (status !== 'available') {
    return {
      status,
      count: null,
      completedCount: null,
      completionRate: null,
    };
  }
  return {
    status,
    count: recordCount,
    completedCount,
    completionRate: Math.round((completedCount / recordCount) * 10_000) / 10_000,
  };
}

function reviewRateMetric(
  recordCountInput: unknown,
  participantCountInput: unknown,
  approvedCountInput: unknown,
): BoardReviewRateMetric {
  const metric = rateMetric(
    recordCountInput,
    participantCountInput,
    approvedCountInput,
  );
  return {
    status: metric.status,
    count: metric.count,
    approvedCount: metric.completedCount,
    approvalRate: metric.completionRate,
  };
}

export function buildBoardSummary(
  row: BoardSummaryRow,
  generatedAt = new Date().toISOString(),
): BoardSummary {
  const activeAthleteCount = safeCount(row.active_athlete_count);
  return {
    scope: 'organization_aggregate',
    minimumCohortSize: BOARD_MINIMUM_COHORT_SIZE,
    generatedAt,
    activeAthletes: boardCountMetric(activeAthleteCount, activeAthleteCount),
    trainingSessions30Days: rateMetric(
      row.session_count,
      row.session_athlete_count,
      row.completed_session_count,
    ),
    goalStatusBuckets: {
      active: boardCountMetric(
        row.active_goal_count,
        row.active_goal_athlete_count,
      ),
      completed: boardCountMetric(
        row.completed_goal_count,
        row.completed_goal_athlete_count,
      ),
      other: boardCountMetric(
        row.other_goal_count,
        row.other_goal_athlete_count,
      ),
    },
    coachReviews30Days: reviewRateMetric(
      row.review_count,
      row.review_athlete_count,
      row.approved_review_count,
    ),
  };
}

export async function getBoardSummary(
  organizationId: string,
): Promise<BoardSummary> {
  if (!organizationId.trim()) {
    throw new Error('Forbidden: Board summary requires an organization');
  }

  const row = await queryOne<BoardSummaryRow>(
    `with active_athletes as (
       select athlete_id
       from pilot.athletes
       where organization_id = $1
         and active_flag = true
     ),
     recent_sessions as (
       select s.athlete_id, s.completed_flag
       from pilot.sessions s
       join active_athletes a on a.athlete_id = s.athlete_id
       where s.organization_id = $1
         and s.date >= current_date - interval '30 days'
     ),
     scoped_goals as (
       select g.athlete_id,
              case
                when lower(g.status) in ('active', 'open', 'in_progress', 'in-progress') then 'active'
                when lower(g.status) in ('completed', 'complete', 'achieved') then 'completed'
                else 'other'
              end as status_bucket
       from pilot.goals g
       join active_athletes a on a.athlete_id = g.athlete_id
       where g.organization_id = $1
     ),
     recent_reviews as (
       select s.athlete_id, cr.approved_flag
       from pilot.coach_reviews cr
       join pilot.sessions s
         on s.organization_id = cr.organization_id
        and s.session_id = cr.session_id
       join active_athletes a on a.athlete_id = s.athlete_id
       where cr.organization_id = $1
         and cr.created_at >= now() - interval '30 days'
     )
     select
       (select count(*) from active_athletes)::int as active_athlete_count,
       (select count(*) from recent_sessions)::int as session_count,
       (select count(distinct athlete_id) from recent_sessions)::int as session_athlete_count,
       (select count(*) from recent_sessions where completed_flag)::int as completed_session_count,
       (select count(*) from scoped_goals where status_bucket = 'active')::int as active_goal_count,
       (select count(distinct athlete_id) from scoped_goals where status_bucket = 'active')::int as active_goal_athlete_count,
       (select count(*) from scoped_goals where status_bucket = 'completed')::int as completed_goal_count,
       (select count(distinct athlete_id) from scoped_goals where status_bucket = 'completed')::int as completed_goal_athlete_count,
       (select count(*) from scoped_goals where status_bucket = 'other')::int as other_goal_count,
       (select count(distinct athlete_id) from scoped_goals where status_bucket = 'other')::int as other_goal_athlete_count,
       (select count(*) from recent_reviews)::int as review_count,
       (select count(distinct athlete_id) from recent_reviews)::int as review_athlete_count,
       (select count(*) from recent_reviews where approved_flag)::int as approved_review_count`,
    [organizationId],
  );

  if (!row) {
    throw new Error('BOARD_SUMMARY_UNAVAILABLE');
  }
  return buildBoardSummary(row);
}
