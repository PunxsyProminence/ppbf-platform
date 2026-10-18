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

  it('does not report a fine-tuning pipeline as on when an admin enables it and the counter is met, because none is built', async () => {
    // The admin panel can set any feature to 'enabled'. Before this, 600
    // reviewed events against a threshold of 500 made fine_tuning_pipeline
    // "unlocked" -- and metrics/route.ts reported fineTuningPipelineReady --
    // while no fine-tuning code exists anywhere in the app.
    mockedQuery.mockImplementation(async (sql) => {
      if (!String(sql).includes('SELECT organization_id, feature_key')) return [] as never;
      return [
        {
          organization_id: 'org-a',
          feature_key: 'fine_tuning_pipeline',
          metric_key: 'org_labeled_training_examples',
          min_value: 500,
          activation_mode: 'enabled',
          description: 'enabled by an admin',
        },
        {
          organization_id: 'org-a',
          feature_key: 'strong_personalization',
          metric_key: 'user_high_quality_interactions',
          min_value: 20,
          activation_mode: 'enabled',
          description: 'enabled',
        },
      ] as never;
    });

    const state = await evaluateShadowUnlockState({
      organizationId: 'org-a',
      accountId: 'account-a',
    });

    expect(state.features.fine_tuning_pipeline).toEqual(expect.objectContaining({
      activationMode: 'enabled',
      satisfied: true,
      implemented: false,
      unlocked: false,
      measuredPerformance: null,
    }));
    expect(state.features.aggressive_research_generation.implemented).toBe(false);
    expect(state.features.auto_library_updates.implemented).toBe(true);
    // A built feature in the same position does turn on.
    expect(state.features.strong_personalization).toEqual(expect.objectContaining({
      satisfied: true,
      implemented: true,
      unlocked: true,
      measuredPerformance: null,
    }));
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
      implemented: true,
      measuredPerformance: null,
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

  it('flags an activatable feature as close to unlocking once progress crosses 80%', () => {
    const state: ShadowUnlockState = {
      organizationId: 'org-a',
      accountId: 'account-a',
      evaluatedAt: new Date().toISOString(),
      features: {
        strong_personalization: featureStatus({ activationMode: 'enabled', currentValue: 9, thresholdValue: 10 }),
      } as ShadowUnlockState['features'],
    };

    const hints = buildShadowUnlockHints(state);
    expect(hints?.[0].progress).toBe(0.9);
    expect(hints?.[0].closeToUnlocking).toBe(true);
  });

  it('never promises unlocking for a feature whose activation mode cannot unlock', () => {
    // Three of four features default to observation/disabled: unlocked
    // requires activationMode === 'enabled', so a full counter used to show
    // a 100%-progress "close to unlocking" banner forever, for features that
    // could not unlock without an admin threshold change.
    const state: ShadowUnlockState = {
      organizationId: 'org-a',
      accountId: 'account-a',
      evaluatedAt: new Date().toISOString(),
      features: {
        strong_personalization: featureStatus({ activationMode: 'observation', satisfied: true, currentValue: 10, thresholdValue: 10 }),
      } as ShadowUnlockState['features'],
    };

    const hints = buildShadowUnlockHints(state);
    expect(hints?.[0].progress).toBe(1);
    expect(hints?.[0].closeToUnlocking).toBe(false);
  });

  it('never promises unlocking for a feature with no code behind it', () => {
    const state: ShadowUnlockState = {
      organizationId: 'org-a',
      accountId: 'account-a',
      evaluatedAt: new Date().toISOString(),
      features: {
        fine_tuning_pipeline: featureStatus({
          featureKey: 'fine_tuning_pipeline',
          metricKey: 'org_labeled_training_examples',
          activationMode: 'enabled',
          implemented: false,
          currentValue: 450,
          thresholdValue: 500,
        }),
      } as unknown as ShadowUnlockState['features'],
    };

    const hints = buildShadowUnlockHints(state);
    expect(hints?.[0].progress).toBe(0.9);
    expect(hints?.[0].closeToUnlocking).toBe(false);
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
