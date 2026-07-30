import { query } from './db';
import { processLearningSignal } from './shadowLearningLoop';
import { recordRecommendationEffectiveness } from './shadowMetrics';
import { createShadowResearchRequirement } from './shadowResearch';
import { evaluateShadowUnlockState, isFeatureEnabled } from './shadowUnlocks';
import { upsertRememberedFact } from './shadowUserProfile';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));
jest.mock('./shadowMetrics', () => ({
  recordRecommendationEffectiveness: jest.fn(),
}));
jest.mock('./shadowResearch', () => ({
  createShadowResearchRequirement: jest.fn(),
}));
jest.mock('./shadowUnlocks', () => ({
  evaluateShadowUnlockState: jest.fn(),
  isFeatureEnabled: jest.fn(),
}));
jest.mock('./shadowUserProfile', () => ({
  upsertRememberedFact: jest.fn(),
}));

const mockQuery = jest.mocked(query);
const mockRecordMetrics = jest.mocked(recordRecommendationEffectiveness);
const mockResearch = jest.mocked(createShadowResearchRequirement);
const mockEvaluateUnlocks = jest.mocked(evaluateShadowUnlockState);
const mockFeatureEnabled = jest.mocked(isFeatureEnabled);
const mockRememberFact = jest.mocked(upsertRememberedFact);

const baseSignal = {
  feedbackId: 12,
  messageId: 'durable-message-1',
  userId: 'account-1',
  organizationId: 'org-1',
  role: 'athlete' as const,
  topic: 'footwork',
  sessionType: 'quick_round',
  outcome: 'thumbs_up' as const,
};

describe('SHADOW learning-loop trust gates', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockQuery.mockResolvedValue([]);
    mockRecordMetrics.mockResolvedValue(undefined);
    mockResearch.mockResolvedValue(1);
    mockEvaluateUnlocks.mockResolvedValue({ features: {} } as never);
    mockFeatureEnabled.mockReturnValue(true);
    mockRememberFact.mockResolvedValue(undefined);
  });

  test('rejects unverified signals without recording effectiveness or profile facts', async () => {
    const result = await processLearningSignal({
      ...baseSignal,
      verificationState: 'unverified',
    });
    expect(result.metricsRecorded).toBe(false);
    expect(result.profileUpdated).toBe(false);
    expect(result.humanReviewRequired).toBe(true);
    expect(mockRecordMetrics).not.toHaveBeenCalled();
    expect(mockRememberFact).not.toHaveBeenCalled();
    expect(mockResearch).not.toHaveBeenCalled();
  });

  test('records durable client feedback but only queues a human review', async () => {
    const result = await processLearningSignal({
      ...baseSignal,
      verificationState: 'durable_client',
    });
    expect(result.metricsRecorded).toBe(true);
    expect(result.profileUpdated).toBe(false);
    expect(result.humanReviewRequired).toBe(true);
    expect(mockRecordMetrics).toHaveBeenCalledWith(expect.objectContaining({
      feedbackId: 12,
      recommendationId: 'durable-message-1',
      verificationState: 'durable_client',
      humanReviewRequired: true,
    }));
    expect(mockEvaluateUnlocks).not.toHaveBeenCalled();
    expect(mockRememberFact).not.toHaveBeenCalled();
    expect(mockResearch).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.some(([sql]) =>
      typeof sql === 'string' && sql.includes("review_state, flagged_at")
    )).toBe(true);
    expect(mockQuery.mock.calls.some(([sql]) =>
      typeof sql === 'string'
      && sql.includes('IS DISTINCT FROM EXCLUDED.feedback_id')
    )).toBe(true);
    expect(result.actions.join(' ')).toContain('no learning was promoted');
  });

  test('human-reviewed feedback may update personalization but still queues library changes', async () => {
    const result = await processLearningSignal({
      ...baseSignal,
      verificationState: 'human_reviewed',
    });
    expect(mockEvaluateUnlocks).toHaveBeenCalled();
    expect(mockRememberFact).toHaveBeenCalled();
    expect(mockRecordMetrics).toHaveBeenCalledWith(expect.objectContaining({
      verificationState: 'human_reviewed',
      humanReviewRequired: false,
    }));
    expect(mockQuery.mock.calls.some(([sql]) =>
      typeof sql === 'string' && sql.includes("proposed_action")
    )).toBe(true);
    expect(result.actions.join(' ')).toContain('queued for human review');
    expect(result.actions.join(' ')).not.toContain('entry promoted');
    expect(mockQuery.mock.calls.some(([sql]) =>
      typeof sql === 'string'
      && sql.includes('ON CONFLICT (feedback_id, verification_state)')
      && sql.includes('actions_taken = EXCLUDED.actions_taken')
    )).toBe(true);
    expect(mockQuery.mock.calls.some(([sql]) =>
      typeof sql === 'string'
      && sql.includes('IS DISTINCT FROM EXCLUDED.feedback_id')
    )).toBe(true);
  });

  test('locked features stay in observation mode -- the path production actually runs', async () => {
    // The audit flagged that every test here forced isFeatureEnabled to true,
    // leaving the locked-feature behavior -- the default state of every real
    // deployment -- with zero coverage. This pins it: no auto library change,
    // and the audit trail says observation mode explicitly.
    mockFeatureEnabled.mockReturnValue(false);

    const result = await processLearningSignal({
      ...baseSignal,
      verificationState: 'human_reviewed',
    });

    expect(result.actions.join(' ')).toContain('observation mode');
    expect(result.actions.join(' ')).not.toContain('entry promoted');
  });

  test('a research-requirement failure is attributed to itself, not to the library flag', async () => {
    // The two writes live in separate failure domains. A single catch used to
    // log "Library review flag failed" when the flag had succeeded and only
    // the research requirement had failed -- a false statement in the durable
    // learning audit.
    mockFeatureEnabled.mockReturnValue(false);
    mockResearch.mockRejectedValue(new Error('research write failed'));

    const result = await processLearningSignal({
      ...baseSignal,
      outcome: 'thumbs_down' as const,
      verificationState: 'human_reviewed',
    });

    const trail = result.actions.join(' | ');
    expect(trail).toContain('Library entry flagged for review');
    expect(trail).toContain('Research requirement creation failed');
    expect(trail).not.toContain('Library review flag failed');
  });
});
