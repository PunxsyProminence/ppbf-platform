import { queryOne } from './db';
import {
  BOARD_MINIMUM_COHORT_SIZE,
  buildBoardSummary,
  getBoardSummary,
} from './boardSummary';

jest.mock('./db', () => ({
  queryOne: jest.fn(),
}));

const mockQueryOne = jest.mocked(queryOne);

const availableRow = {
  active_athlete_count: 12,
  session_count: 10,
  session_athlete_count: 7,
  completed_session_count: 8,
  active_goal_count: 9,
  active_goal_athlete_count: 6,
  completed_goal_count: 7,
  completed_goal_athlete_count: 5,
  other_goal_count: 6,
  other_goal_athlete_count: 5,
  review_count: 8,
  review_athlete_count: 6,
  approved_review_count: 6,
};

describe('aggregate-only Board summary', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  test('returns only the fixed aggregate contract for sufficiently large cohorts', () => {
    const summary = buildBoardSummary(
      availableRow,
      '2026-07-24T12:00:00.000Z',
    );

    expect(Object.keys(summary)).toEqual([
      'scope',
      'minimumCohortSize',
      'generatedAt',
      'activeAthletes',
      'trainingSessions30Days',
      'goalStatusBuckets',
      'coachReviews30Days',
    ]);
    expect(summary).toMatchObject({
      scope: 'organization_aggregate',
      minimumCohortSize: BOARD_MINIMUM_COHORT_SIZE,
      activeAthletes: { status: 'available', count: 12 },
      trainingSessions30Days: {
        status: 'available',
        count: 10,
        completedCount: 8,
        completionRate: 0.8,
      },
      coachReviews30Days: {
        status: 'available',
        count: 8,
        approvedCount: 6,
        approvalRate: 0.75,
      },
    });
    expect(JSON.stringify(summary)).not.toMatch(
      /accountId|account_id|athleteId|athlete_id|full_name|notes|message|content/i,
    );
  });

  test('suppresses cohorts under five and distinguishes absent data from zero', () => {
    const summary = buildBoardSummary({
      ...availableRow,
      active_athlete_count: 4,
      session_count: 0,
      session_athlete_count: 0,
      completed_session_count: 0,
      active_goal_count: 3,
      active_goal_athlete_count: 3,
      completed_goal_count: 0,
      completed_goal_athlete_count: 0,
      other_goal_count: 0,
      other_goal_athlete_count: 0,
      review_count: 2,
      review_athlete_count: 2,
      approved_review_count: 1,
    });

    expect(summary.activeAthletes).toEqual({
      status: 'insufficient_data',
      count: null,
    });
    expect(summary.trainingSessions30Days).toEqual({
      status: 'unavailable',
      count: null,
      completedCount: null,
      completionRate: null,
    });
    expect(summary.goalStatusBuckets.active).toEqual({
      status: 'insufficient_data',
      count: null,
    });
    expect(summary.goalStatusBuckets.completed).toEqual({
      status: 'unavailable',
      count: null,
    });
    expect(summary.coachReviews30Days).toEqual({
      status: 'insufficient_data',
      count: null,
      approvedCount: null,
      approvalRate: null,
    });
  });

  test('preserves a measured zero rate when the cohort and denominator are available', () => {
    const summary = buildBoardSummary({
      ...availableRow,
      session_count: 6,
      session_athlete_count: 6,
      completed_session_count: 0,
    });

    expect(summary.trainingSessions30Days).toMatchObject({
      status: 'available',
      count: 6,
      completedCount: 0,
      completionRate: 0,
    });
  });

  test('uses the authenticated organization as the sole query parameter', async () => {
    mockQueryOne.mockResolvedValueOnce(availableRow);

    await getBoardSummary('org-authenticated');

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(params).toEqual(['org-authenticated']);
    expect(sql.match(/organization_id = \$1/g)?.length).toBeGreaterThanOrEqual(4);
    expect(sql).not.toMatch(/\b(full_name|notes|content|message)\b/i);
  });
});
