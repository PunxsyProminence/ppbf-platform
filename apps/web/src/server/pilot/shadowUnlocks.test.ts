import { query, queryOne } from './db';
import { evaluateShadowUnlockState, buildShadowUnlockHints, type ShadowUnlockState } from './shadowUnlocks';

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockedQuery = query as jest.MockedFunction<typeof query>;
const mockedQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;

describe('SHADOW feature unlock governance', () => {
  beforeEach(() => {
    mockedQuery.mockReset();
    mockedQueryOne.mockReset();
    mockedQuery.mockResolvedValue([]);
    mockedQueryOne.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('shadow_feature_thresholds')) return { count: '1' } as never;
      if (text.includes('shadow_feedback')) return { count: '25' } as never;
      if (text.includes('shadow_jobs')) return { count: '12' } as never;
      if (text.includes('message_id IS NOT NULL')) return { count: '600' } as never;
      if (text.includes('shadow_learning_events')) return { count: '50' } as never;
      return { count: '0' } as never;
    });
  });

  it('never treats event volume alone as permission to fine-tune', async () => {
    const state = await evaluateShadowUnlockState({
      organizationId: 'org-a',
      accountId: 'account-a',
    });

    expect(state.features.fine_tuning_pipeline.activationMode).toBe('disabled');
    expect(state.features.fine_tuning_pipeline.satisfied).toBe(true);
    expect(state.features.fine_tuning_pipeline.unlocked).toBe(false);
  });

  it('counts only human-reviewed learning events and performs no runtime DDL', async () => {
    await evaluateShadowUnlockState({
      organizationId: 'org-a',
      accountId: 'account-a',
    });

    const learningQueries = mockedQueryOne.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('shadow_learning_events'));
    expect(learningQueries).toHaveLength(2);
    expect(learningQueries.every((sql) => sql.includes("verification_state = 'human_reviewed'"))).toBe(true);

    const everySql = [
      ...mockedQuery.mock.calls.map(([sql]) => String(sql)),
      ...mockedQueryOne.mock.calls.map(([sql]) => String(sql)),
    ].join('\n').toLowerCase();
    expect(everySql).not.toContain('create table');
    expect(everySql).not.toContain('alter table');
  });
});

describe('buildShadowUnlockHints', () => {
  function featureStatus(overrides: Partial<ShadowUnlockState['features'][keyof ShadowUnlockState['features']]> = {}) {
    return {
      featureKey: 'strong_personalization' as const,
      unlocked: false,
      activationMode: 'observation' as const,
      satisfied: false,
      currentValue: 0,
      thresholdValue: 10,
      metricKey: 'user_high_quality_interactions' as const,
      ...overrides,
    };
  }

  it('returns undefined when there is no unlock state to summarize', () => {
    expect(buildShadowUnlockHints(null)).toBeUndefined();
  });

  it('never leaks internal metricKey/activationMode/raw values into the client projection', () => {
    const state: ShadowUnlockState = {
      organizationId: 'org-a',
      accountId: 'account-a',
      evaluatedAt: new Date().toISOString(),
      features: { strong_personalization: featureStatus() } as ShadowUnlockState['features'],
    };

    const hints = buildShadowUnlockHints(state);
    expect(hints).toHaveLength(1);
    expect(hints?.[0]).toEqual({
      featureKey: 'strong_personalization',
      unlocked: false,
      progress: 0,
      closeToUnlocking: false,
    });
  });

  it('flags a feature as close to unlocking once progress crosses 80% without being unlocked yet', () => {
    const state: ShadowUnlockState = {
      organizationId: 'org-a',
      accountId: 'account-a',
      evaluatedAt: new Date().toISOString(),
      features: {
        strong_personalization: featureStatus({ currentValue: 9, thresholdValue: 10 }),
      } as ShadowUnlockState['features'],
    };

    const hints = buildShadowUnlockHints(state);
    expect(hints?.[0].progress).toBe(0.9);
    expect(hints?.[0].closeToUnlocking).toBe(true);
  });

  it('never reports closeToUnlocking once a feature is already unlocked', () => {
    const state: ShadowUnlockState = {
      organizationId: 'org-a',
      accountId: 'account-a',
      evaluatedAt: new Date().toISOString(),
      features: {
        strong_personalization: featureStatus({ unlocked: true, satisfied: true, currentValue: 10, thresholdValue: 10 }),
      } as ShadowUnlockState['features'],
    };

    const hints = buildShadowUnlockHints(state);
    expect(hints?.[0].progress).toBe(1);
    expect(hints?.[0].closeToUnlocking).toBe(false);
  });

  it('falls back to a 0/1 progress split on a satisfied-but-zero-threshold feature instead of dividing by zero', () => {
    const state: ShadowUnlockState = {
      organizationId: 'org-a',
      accountId: 'account-a',
      evaluatedAt: new Date().toISOString(),
      features: {
        strong_personalization: featureStatus({ thresholdValue: 0, satisfied: true }),
      } as ShadowUnlockState['features'],
    };

    expect(buildShadowUnlockHints(state)?.[0].progress).toBe(1);
  });
});
