import { query, queryOne, withTransaction } from './db';
import { processLearningSignal } from './shadowLearningLoop';
import { recordRecommendationEffectiveness } from './shadowMetrics';
import { createShadowResearchRequirement } from './shadowResearch';
import { evaluateShadowUnlockState, isFeatureEnabled } from './shadowUnlocks';
import { upsertRememberedFact } from './shadowUserProfile';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
  sanitizedSqlState: jest.fn(),
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
const mockQueryOne = jest.mocked(queryOne);
const mockRecordMetrics = jest.mocked(recordRecommendationEffectiveness);
const mockResearch = jest.mocked(createShadowResearchRequirement);
const mockEvaluateUnlocks = jest.mocked(evaluateShadowUnlockState);
const mockFeatureEnabled = jest.mocked(isFeatureEnabled);
const mockRememberFact = jest.mocked(upsertRememberedFact);
const mockWithTransaction = jest.mocked(withTransaction);

// The once-only effects run in a transaction under a lock on the feedback
// row. Its client answers the lock with `effectsDone` and the row's current
// judgment (`lockedOutcome`, defaulting to the signal's), and sends every
// other statement through mockQuery, so the SQL assertions below see them all.
let effectsDone: string[] = [];
let lockedOutcome: string | null = null;
let lockedPending = true;
let lastOutcome = 'thumbs_up';
const transactionClient = {
  async query(sql: string, params?: unknown[]) {
    if (sql.includes('FROM pilot.shadow_feedback') && sql.includes('FOR UPDATE')) {
      return { rows: [{
        learning_effects_done: effectsDone,
        outcome_signal: lockedOutcome ?? lastOutcome,
        comment: null,
        human_review_required: lockedPending,
      }] };
    }
    return { rows: (await mockQuery(sql, params as never)) ?? [] };
  },
};
const sqlCalls = () => mockQuery.mock.calls.map(([sql]) => String(sql));
const runLoop = (signal: Parameters<typeof processLearningSignal>[0]) => {
  lastOutcome = signal.outcome;
  return processLearningSignal(signal);
};

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
    mockQueryOne.mockResolvedValue(null);
    mockRecordMetrics.mockResolvedValue(undefined);
    mockResearch.mockResolvedValue(1);
    mockEvaluateUnlocks.mockResolvedValue({ features: {} } as never);
    mockFeatureEnabled.mockReturnValue(true);
    mockRememberFact.mockResolvedValue(undefined);
    effectsDone = [];
    lockedOutcome = null;
    lockedPending = true;
    mockWithTransaction.mockImplementation(async (fn) => fn(transactionClient as never));
  });

  test('rejects unverified signals without recording effectiveness or profile facts', async () => {
    const result = await runLoop({
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
    const result = await runLoop({
      ...baseSignal,
      outcome: 'thumbs_down',
      verificationState: 'durable_client',
    });
    expect(result.metricsRecorded).toBe(true);
    expect(result.profileUpdated).toBe(false);
    expect(result.humanReviewRequired).toBe(true);
    // Written in the projection's transaction, under the feedback lock.
    expect(mockRecordMetrics).toHaveBeenCalledWith(expect.objectContaining({
      feedbackId: 12,
      recommendationId: 'durable-message-1',
      verificationState: 'durable_client',
      humanReviewRequired: true,
    }), transactionClient);
    expect(mockEvaluateUnlocks).not.toHaveBeenCalled();
    expect(mockRememberFact).not.toHaveBeenCalled();
    expect(mockResearch).not.toHaveBeenCalled();
    expect(mockQuery.mock.calls.some(([sql]) =>
      typeof sql === 'string' && sql.includes("review_state, flagged_at")
    )).toBe(true);
    expect(sqlCalls().some((sql) => sql.includes('flag_count = pilot.shadow_library_review_flags.flag_count + 1'))).toBe(true);
    expect(result.actions.join(' ')).toContain('no learning was promoted');
    expect(result.complete).toBe(true);
  });

  // O11 = A (GO-RECS-CONFIRMED, Jason 2026-10-08): a Library review flag comes
  // from negative feedback only. Every outcome is tried, because the old code
  // flagged all seven and a test that only tried thumbs_down would have passed
  // against it.
  describe('a durable client signal flags the Library only for negative feedback', () => {
    const FLAG_SQL = 'review_state, flagged_at';
    const flagWritten = () => mockQuery.mock.calls.some(([sql]) =>
      typeof sql === 'string' && sql.includes(FLAG_SQL));

    test.each([
      ['thumbs_down', true],
      ['escalated_to_human', true],
      ['thumbs_up', false],
      ['followed_advice', false],
      ['asked_followup', false],
      ['session_ended', false],
      // Negative only under the aggressive_research_generation unlock, which
      // is a human-reviewed path with an unlock state loaded; this path has
      // neither, so it is not negative here.
      ['ignored_advice', false],
    ] as const)('%s -> flag written: %s', async (outcome, flagged) => {
      const result = await runLoop({
        ...baseSignal,
        outcome,
        verificationState: 'durable_client',
      });
      // Metrics are recorded for every outcome, praise included.
      expect(mockRecordMetrics).toHaveBeenCalledWith(expect.objectContaining({
        feedbackId: 12,
        verificationState: 'durable_client',
      }), transactionClient);
      expect(result.metricsRecorded).toBe(true);
      expect(result.libraryFlagged).toBe(flagged);
      expect(flagWritten()).toBe(flagged);
      if (flagged) {
        // One row per (organization, topic): a negative flag landing on a
        // topic that holds a pending 'promote' proposal must clear it, or the
        // metrics route's promote exclusion would hide this flag.
        const flagSql = mockQuery.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes(FLAG_SQL));
        expect(flagSql).toContain('proposed_action = NULL');
      } else {
        expect(result.actions.join(' ')).toContain(`no Library flag for ${outcome}`);
      }
      // Nothing on this path promotes learning, whatever the outcome.
      expect(result.humanReviewRequired).toBe(true);
      expect(mockRememberFact).not.toHaveBeenCalled();
      expect(mockResearch).not.toHaveBeenCalled();
    });
  });

  test('human-reviewed feedback may update personalization but still queues library changes', async () => {
    const result = await runLoop({
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
    expect(sqlCalls().some((sql) => sql.includes('IS DISTINCT FROM EXCLUDED.feedback_id'))).toBe(false);
    expect(sqlCalls().some((sql) => sql.includes("array_append(learning_effects_done, 'complete')"))).toBe(true);
    expect(result.complete).toBe(true);
    // The proposal re-points the flag at this account; an earlier flagger's
    // note goes with the earlier account, never shown as this one's.
    const proposal = mockQuery.mock.calls.find(([sql]) =>
      typeof sql === 'string' && sql.includes('proposed_action') && sql.includes('ON CONFLICT (organization_id, topic)'));
    expect(proposal?.[0]).toMatch(/DO UPDATE SET[\s\S]*user_note = NULL/);
  });

  test('locked features stay in observation mode -- the path production actually runs', async () => {
    // The audit flagged that every test here forced isFeatureEnabled to true,
    // leaving the locked-feature behavior -- the default state of every real
    // deployment -- with zero coverage. This pins it: no auto library change,
    // and the audit trail says observation mode explicitly.
    mockFeatureEnabled.mockReturnValue(false);

    const result = await runLoop({
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

    const result = await runLoop({
      ...baseSignal,
      outcome: 'thumbs_down' as const,
      verificationState: 'human_reviewed',
    });

    const trail = result.actions.join(' | ');
    expect(trail).toContain('Library entry flagged for review');
    expect(trail).toContain('Research requirement creation failed');
    expect(trail).not.toContain('Library review flag failed');
  });

  test('a human-reviewed negative flag clears a pending promote proposal on the topic', async () => {
    mockFeatureEnabled.mockReturnValue(false);
    await runLoop({
      ...baseSignal,
      outcome: 'escalated_to_human' as const,
      verificationState: 'human_reviewed',
    });
    const flagSql = mockQuery.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('latest_outcome_signal = $6'));
    expect(flagSql).toBeDefined();
    expect(flagSql).toContain('proposed_action = NULL');
  });

  // One feedback event has each once-only effect once, whatever the retries
  // (L46 item 1). Real-database proof: shadowLearningIntegrity.pg.test.ts.
  describe('once-only effects and completion', () => {
    const markWritten = (effect: string) => mockQuery.mock.calls.some(([sql, params]) =>
      String(sql).includes('array_append(learning_effects_done, $3::text)')
      && Array.isArray(params) && params[2] === effect);
    const completeWritten = () => sqlCalls().some((sql) => sql.includes("array_append(learning_effects_done, 'complete')"));

    test('a failed fact write leaves the approval incomplete, unmarked, and not complete', async () => {
      mockRememberFact.mockRejectedValue(new Error('profile write failed'));
      const result = await runLoop({ ...baseSignal, verificationState: 'human_reviewed' });
      expect(result.actions).toContain('Fact extraction failed');
      expect(result.complete).toBe(false);
      expect(markWritten('facts')).toBe(false);
      expect(completeWritten()).toBe(false);
    });

    test('facts are counted inside the marking transaction, and not again once marked', async () => {
      await runLoop({ ...baseSignal, verificationState: 'human_reviewed' });
      expect(mockRememberFact).toHaveBeenCalledWith('account-1', 'org-1', expect.objectContaining({ key: 'engaged_topic_footwork' }), transactionClient);
      expect(markWritten('facts')).toBe(true);

      jest.clearAllMocks();
      effectsDone = ['facts'];
      const retry = await runLoop({ ...baseSignal, verificationState: 'human_reviewed' });
      expect(mockRememberFact).not.toHaveBeenCalled();
      expect(retry.actions).toContain('Facts from this feedback were already counted');
      expect(retry.complete).toBe(true);
    });

    test('a topic flag this feedback already counted is not re-written, reopened or re-marked', async () => {
      effectsDone = ['library_flag'];
      await runLoop({ ...baseSignal, outcome: 'thumbs_down', verificationState: 'human_reviewed' });
      expect(sqlCalls().some((sql) => sql.includes('INSERT INTO pilot.shadow_library_review_flags'))).toBe(false);
      const refresh = sqlCalls().find((sql) => sql.includes('SET user_note = $4'));
      expect(refresh).toContain("AND review_state = 'pending' AND proposed_action IS NULL");
      expect(markWritten('library_flag')).toBe(false);
    });

    test('a client projection follows the row it locked, not a stale caller', async () => {
      lockedOutcome = 'thumbs_up';
      const result = await runLoop({ ...baseSignal, outcome: 'thumbs_down', verificationState: 'durable_client' });
      expect(result.libraryFlagged).toBe(false);
      expect(sqlCalls().some((sql) => sql.includes('INSERT INTO pilot.shadow_library_review_flags'))).toBe(false);
    });

    test('a client projection leaves a reviewed row to the approval path', async () => {
      lockedPending = false;
      const result = await runLoop({ ...baseSignal, outcome: 'thumbs_down', verificationState: 'durable_client' });
      expect(result.libraryFlagged).toBe(false);
      expect(sqlCalls().some((sql) => sql.includes('shadow_library_review_flags'))).toBe(false);
    });

    test('an unreadable unlock state is a retryable failure, not a reason to skip effects', async () => {
      mockEvaluateUnlocks.mockRejectedValue(new Error('unlock read failed'));
      const result = await runLoop({ ...baseSignal, verificationState: 'human_reviewed' });
      expect(result.actions).toContain('Unlock state unavailable');
      expect(result.complete).toBe(false);
      expect(completeWritten()).toBe(false);
    });

    test('a failed learning log keeps the approval incomplete', async () => {
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO pilot.shadow_learning_events')) throw new Error('log failed');
        return [];
      });
      const result = await runLoop({ ...baseSignal, verificationState: 'human_reviewed' });
      expect(result.complete).toBe(false);
      expect(completeWritten()).toBe(false);
    });

    test('a client signal no longer negative withdraws the flag it counted', async () => {
      effectsDone = ['library_flag'];
      const result = await runLoop({ ...baseSignal, outcome: 'thumbs_up', verificationState: 'durable_client' });
      expect(sqlCalls().some((sql) => sql.includes('FROM pilot.shadow_library_review_flags') && sql.includes('FOR UPDATE'))).toBe(true);
      expect(mockQuery.mock.calls.some(([sql, params]) =>
        String(sql).includes('array_remove(learning_effects_done, $3::text)') && Array.isArray(params) && params[2] === 'library_flag')).toBe(true);
      expect(result.libraryFlagged).toBe(false);
      expect(result.complete).toBe(true);
    });
  });

  // communication_style was unwritable in production: the inference required
  // signal.responseText, and neither feedback call site supplies it. The loop
  // now reads the durable assistant message itself, so an approved thumbs-up
  // can set the preference without trusting client-sent text.
  describe('communication style inference', () => {
    test('approved thumbs-up loads the durable response text and writes the style', async () => {
      mockQueryOne.mockResolvedValue({ content: 'Keep your guard up between combinations.' });

      const result = await runLoop({
        ...baseSignal,
        verificationState: 'human_reviewed',
      });

      expect(mockQueryOne).toHaveBeenCalledWith(
        expect.stringContaining('FROM pilot.shadow_chat_messages'),
        ['durable-message-1', 'org-1', 'account-1'],
      );
      const styleUpdate = mockQuery.mock.calls.find(([sql]) =>
        typeof sql === 'string' && sql.includes('SET communication_style'));
      expect(styleUpdate).toBeDefined();
      expect(styleUpdate?.[1]).toEqual(['account-1', 'org-1', 'concise']);
      expect(result.actions.join(' ')).toContain('Communication preference updated');
    });

    test('a missing durable message skips the style update without failing the loop', async () => {
      mockQueryOne.mockResolvedValue(null);

      const result = await runLoop({
        ...baseSignal,
        verificationState: 'human_reviewed',
      });

      expect(mockQuery.mock.calls.some(([sql]) =>
        typeof sql === 'string' && sql.includes('SET communication_style'))).toBe(false);
      expect(result.actions.join(' ')).not.toContain('Communication preference updated');
      expect(result.profileUpdated).toBe(true);
    });

    test('durable-client feedback never touches the durable message text', async () => {
      await runLoop({
        ...baseSignal,
        verificationState: 'durable_client',
      });

      expect(mockQueryOne).not.toHaveBeenCalled();
    });
  });
});
