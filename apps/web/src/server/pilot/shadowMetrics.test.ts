import { query, queryOne } from './db';
import {
  getGrowthMetrics,
  recordRecommendationEffectiveness,
} from './shadowMetrics';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);

describe('SHADOW metrics availability', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockQuery.mockResolvedValue([]);
  });

  test('returns null plus reasons rather than invented values when data is absent', async () => {
    mockQueryOne.mockResolvedValueOnce({
      total_interactions: '0',
      filtered_interactions: '0',
      avg_satisfaction: null,
      avg_effectiveness: null,
      recommendations_made: '0',
      reviewed_helpful: '0',
      reviewed_outcomes: '0',
      research_created: '0',
      research_closed: '0',
      new_library_sources: '0',
    });
    const result = await getGrowthMetrics('org-1', 30);
    expect(result.filterRate).toBeNull();
    expect(result.avgEffectiveness).toBeNull();
    expect(result.reviewedHelpfulRate).toBeNull();
    expect(result.unavailableReasons).toEqual(expect.objectContaining({
      filterRate: 'NO_CHAT_INTERACTIONS_IN_PERIOD',
      avgEffectiveness: 'NO_HUMAN_REVIEWED_OUTCOMES_IN_PERIOD',
      reviewedHelpfulRate: 'NO_HUMAN_REVIEWED_OUTCOMES_IN_PERIOD',
      // The rating UI does not exist, so AVG(rating) is structurally null --
      // the tile must say why rather than render a bare em dash forever.
      avgSatisfaction: 'RATING_INPUT_NOT_BUILT',
    }));
    const sql = mockQueryOne.mock.calls[0][0];
    expect(sql).toContain('FROM pilot.shadow_chat_audit');
    expect(sql).toContain("verification_state = 'human_reviewed'");
    expect(sql).not.toContain('FROM pilot.shadow_events\n     WHERE');
  });

  // A reviewed thumbs-up is stored as outcome 'improved'; the rate is the
  // share of reviewed answers rated helpful, and the Library count is new
  // sources. Neither is named for something the app does not measure.
  test('names the rated-helpful share and the new Library sources for what they count', async () => {
    mockQueryOne.mockResolvedValueOnce({
      total_interactions: '10',
      filtered_interactions: '1',
      avg_satisfaction: null,
      avg_effectiveness: '0.8',
      reviewed_helpful: '3',
      reviewed_outcomes: '4',
      research_created: '0',
      research_closed: '0',
      new_library_sources: '2',
    });
    const result = await getGrowthMetrics('org-1', 30);
    expect(result.reviewedHelpfulRate).toBe(0.75);
    expect(result.newLibrarySources).toBe(2);
    expect(result).not.toHaveProperty('positiveOutcomeRate');
    expect(result).not.toHaveProperty('newLibraryPatterns');
    const sql = mockQueryOne.mock.calls[0][0];
    expect(sql).toContain('FROM pilot.shadow_library_sources');
    expect(sql).toContain('AS new_library_sources');
    expect(sql).toContain("AND outcome = 'improved'");
    expect(sql).toContain('AS reviewed_helpful');
  });

  test('stores client feedback as review-required rather than verified learning', async () => {
    await recordRecommendationEffectiveness({
      organizationId: 'org-1',
      userId: 'account-1',
      recommendationType: 'heavy_bag',
      feedbackId: 9,
      recommendationId: 'message-9',
      outcome: 'improved',
      verificationState: 'durable_client',
      humanReviewRequired: true,
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('verification_state');
    expect(sql).toContain('human_review_required');
    expect(sql).toContain("verification_state = 'human_reviewed'");
    expect(sql).toContain("EXCLUDED.verification_state <> 'human_reviewed'");
    expect(params).toContain('durable_client');
    expect(params).toContain(true);
    // The recommendation_type column stores the recommendation kind, not the
    // actor role it used to silently receive.
    expect(params).toContain('heavy_bag');
    // Approval restamps created_at the first time a row reaches
    // human_reviewed: every read windows reviewed counts on created_at, so a
    // late approval must land in the current window instead of vanishing.
    expect(sql).toContain('created_at = CASE');
    expect(sql).toContain("EXCLUDED.verification_state = 'human_reviewed'");
  });
});
