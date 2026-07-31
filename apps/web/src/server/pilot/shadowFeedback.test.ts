import { query, queryOne } from './db';
import {
  recordShadowFeedback,
  hasDurableHumanReviewedLearningEvent,
  listShadowFeedback,
  normalizeShadowFeedbackId,
  resolveShadowFeedbackReview,
  verifyShadowFeedbackCorrelation,
} from './shadowFeedback';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);

describe('SHADOW feedback correlation', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockQuery.mockResolvedValue([]);
  });

  test('requires a durable, account-owned assistant message', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    const correlation = await verifyShadowFeedbackCorrelation({
      organizationId: 'org-1',
      accountId: 'athlete-account-1',
      messageId: 'message-from-another-user',
    });
    expect(correlation).toMatchObject({
      verified: false,
      learningEligible: false,
      reason: 'DURABLE_CORRELATION_REQUIRED',
    });
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('m.organization_id = $2');
    expect(sql).toContain('m.account_id = $3');
    expect(params).toEqual([
      'message-from-another-user',
      'org-1',
      'athlete-account-1',
    ]);
  });

  test('accepts an owned, unfiltered assistant message for review-gated learning', async () => {
    mockQueryOne.mockResolvedValueOnce({
      message_id: 'message-1',
      response_state: 'ok',
      session_type: 'heavy_bag',
    });
    const correlation = await verifyShadowFeedbackCorrelation({
      organizationId: 'org-1',
      accountId: 'athlete-account-1',
      messageId: 'message-1',
    });
    expect(correlation).toMatchObject({
      verified: true,
      learningEligible: true,
      correlationType: 'shadow_message',
      messageId: 'message-1',
      sessionType: 'heavy_bag',
    });
  });

  test('never learns from a filtered response even when ownership is valid', async () => {
    mockQueryOne.mockResolvedValueOnce({
      message_id: 'message-2',
      response_state: 'filtered',
      session_type: 'quick_round',
    });
    const correlation = await verifyShadowFeedbackCorrelation({
      organizationId: 'org-1',
      accountId: 'athlete-account-1',
      messageId: 'message-2',
    });
    expect(correlation.learningEligible).toBe(false);
    expect(correlation.reason).toBe('FILTERED_RESPONSE_NOT_LEARNING_ELIGIBLE');
  });

  test('persists verification and review state rather than trusting a client claim', async () => {
    mockQueryOne.mockResolvedValueOnce({
      feedback_id: '41',
      created: true,
      verification_state: 'durable_client',
      human_review_required: true,
      outcome_signal: 'thumbs_up',
      comment: null,
    });
    const recorded = await recordShadowFeedback({
      organizationId: 'org-1',
      accountId: 'athlete-account-1',
      role: 'athlete',
      helpful: true,
      outcomeSignal: 'thumbs_up',
      correlationType: 'shadow_message',
      correlationId: 'message-1',
      recommendationRef: 'message-1',
      verificationState: 'durable_client',
      humanReviewRequired: true,
    });
    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('verification_state');
    expect(sql).toContain('human_review_required');
    expect(sql).toContain('feedback_id = pilot.shadow_feedback.feedback_id');
    expect(sql).toContain('(xmax = 0) AS created');
    expect(params).toContain('durable_client');
    expect(params).toContain(true);
    expect(recorded).toEqual({
      feedbackId: 41,
      created: true,
      verificationState: 'durable_client',
      humanReviewRequired: true,
      outcomeSignal: 'thumbs_up',
      comment: null,
    });
  });

  test('returns the immutable canonical state for duplicate or closed feedback', async () => {
    mockQueryOne.mockResolvedValueOnce({
      feedback_id: '41',
      created: false,
      verification_state: 'human_reviewed',
      human_review_required: false,
      outcome_signal: 'thumbs_up',
      comment: 'Original reviewed note',
    });

    const recorded = await recordShadowFeedback({
      organizationId: 'org-1',
      accountId: 'athlete-account-1',
      role: 'athlete',
      helpful: false,
      outcomeSignal: 'thumbs_down',
      comment: 'Replacement attempt',
      correlationType: 'shadow_message',
      correlationId: 'message-1',
      recommendationRef: 'message-1',
      verificationState: 'durable_client',
      humanReviewRequired: true,
    });

    expect(recorded).toMatchObject({
      created: false,
      verificationState: 'human_reviewed',
      humanReviewRequired: false,
      outcomeSignal: 'thumbs_up',
      comment: 'Original reviewed note',
    });
  });

  test('resolves approval from the organization-scoped durable feedback and message records', async () => {
    mockQueryOne.mockResolvedValueOnce({
      feedback_id: '41',
      organization_id: 'org-1',
      account_id: 'athlete-account-1',
      role: 'athlete',
      message_id: '00000000-0000-4000-8000-000000000041',
      topic: 'defense',
      session_type: 'heavy_bag',
      outcome_signal: 'thumbs_up',
      user_note: 'This helped.',
      already_resolved: false,
    });

    const review = await resolveShadowFeedbackReview({
      organizationId: 'org-1',
      feedbackId: 41,
      reviewerAccountId: 'admin-1',
      decision: 'approve',
    });

    expect(review).toEqual({
      feedbackId: 41,
      organizationId: 'org-1',
      accountId: 'athlete-account-1',
      role: 'athlete',
      messageId: '00000000-0000-4000-8000-000000000041',
      topic: 'defense',
      sessionType: 'heavy_bag',
      outcomeSignal: 'thumbs_up',
      userNote: 'This helped.',
      decision: 'approve',
      alreadyResolved: false,
    });

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain('f.organization_id = $2');
    expect(sql).toContain("f.correlation_type = 'shadow_message'");
    expect(sql).toContain("m.role = 'assistant'");
    expect(sql).toContain("m.response_state = 'ok'");
    expect(sql).toContain('reviewed_by_account_id');
    expect(sql).toContain("($3 = 'approve' AND scoped.verification_state = 'human_reviewed')");
    expect(params).toEqual([41, 'org-1', 'approve', 'admin-1']);
  });

  test('returns no review context when the scoped conditional update finds no row', async () => {
    mockQueryOne.mockResolvedValueOnce(null);

    await expect(resolveShadowFeedbackReview({
      organizationId: 'org-other',
      feedbackId: 41,
      reviewerAccountId: 'admin-other',
      decision: 'reject',
    })).resolves.toBeNull();
  });

  test('reject remains reachable for items the approve gate refuses', async () => {
    // Feedback on a filtered answer or a deleted session used to match
    // NOTHING -- the eligibility conditions lived in the joins, so Approve
    // and Reject both 404ed and the item wedged the review queue forever.
    // Eligibility is now an approve-only gate.
    mockQueryOne.mockResolvedValueOnce({
      feedback_id: '41',
      organization_id: 'org-1',
      account_id: 'athlete-account-1',
      role: 'athlete',
      message_id: '00000000-0000-4000-8000-000000000041',
      topic: 'defense',
      session_type: 'heavy_bag',
      outcome_signal: 'thumbs_down',
      user_note: null,
      already_resolved: false,
    });

    const review = await resolveShadowFeedbackReview({
      organizationId: 'org-1',
      feedbackId: 41,
      reviewerAccountId: 'admin-1',
      decision: 'reject',
    });

    expect(review).toMatchObject({ feedbackId: 41, decision: 'reject' });
    const [sql] = mockQueryOne.mock.calls[0];
    expect(sql).toContain("($3 = 'reject' OR scoped.learning_eligible)");
    expect(sql).toContain("(m.response_state = 'ok' AND s.deleted_at IS NULL) AS learning_eligible");
    // The joins themselves must NOT filter on state or liveness anymore.
    expect(sql).not.toContain("AND m.response_state = 'ok'\n");
    expect(sql).not.toContain('AND s.deleted_at IS NULL\n');
  });

  test('approve on a reject-only item reports reject_only instead of vanishing', async () => {
    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ present: true });

    const review = await resolveShadowFeedbackReview({
      organizationId: 'org-1',
      feedbackId: 41,
      reviewerAccountId: 'admin-1',
      decision: 'approve',
    });

    expect(review).toBe('reject_only');
    const [fallbackSql, fallbackParams] = mockQueryOne.mock.calls[1];
    expect(fallbackSql).toContain("m.response_state IS DISTINCT FROM 'ok' OR s.deleted_at IS NOT NULL");
    expect(fallbackParams).toEqual([41, 'org-1']);
  });

  test('approve on a genuinely missing item still resolves to null', async () => {
    mockQueryOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await expect(resolveShadowFeedbackReview({
      organizationId: 'org-1',
      feedbackId: 999,
      reviewerAccountId: 'admin-1',
      decision: 'approve',
    })).resolves.toBeNull();
  });

  test('verifies an organization-scoped durable human-reviewed learning event', async () => {
    mockQueryOne.mockResolvedValueOnce({ present: true });

    await expect(hasDurableHumanReviewedLearningEvent({
      organizationId: 'org-1',
      feedbackId: 41,
    })).resolves.toBe(true);

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(sql).toContain("verification_state = 'human_reviewed'");
    expect(sql).toContain('organization_id = $1');
    expect(params).toEqual(['org-1', 41]);
  });

  test('normalizes PostgreSQL int8 feedback ids without accepting unsafe values', async () => {
    expect(normalizeShadowFeedbackId('42')).toBe(42);
    expect(normalizeShadowFeedbackId(42)).toBe(42);
    expect(normalizeShadowFeedbackId('9007199254740992')).toBeNull();
    expect(normalizeShadowFeedbackId('42.5')).toBeNull();

    mockQuery.mockResolvedValueOnce([{
      feedback_id: '42',
      organization_id: 'org-1',
      account_id: 'account-1',
      role: 'athlete',
      shadow_event_id: null,
      recommendation_ref: 'message-42',
      helpful: true,
      rating: 5,
      comment: null,
      outcome_signal: 'thumbs_up',
      correlation_type: 'shadow_message',
      correlation_id: 'message-42',
      verification_state: 'durable_client',
      human_review_required: true,
      created_at: '2026-07-23T00:00:00.000Z',
    }]);

    const items = await listShadowFeedback('org-1', 1);
    expect(items[0].feedback_id).toBe(42);
  });
});
