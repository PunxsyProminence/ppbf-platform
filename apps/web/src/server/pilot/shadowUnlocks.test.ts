import { query, queryOne } from './db';
import { evaluateShadowUnlockState } from './shadowUnlocks';

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
