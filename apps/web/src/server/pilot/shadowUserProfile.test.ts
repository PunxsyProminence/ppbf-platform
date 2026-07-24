jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { query } from './db';
import { updateShadowUserProfile } from './shadowUserProfile';

const mockQuery = query as jest.MockedFunction<typeof query>;

describe('Personal SHADOW profile recency', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQuery.mockResolvedValue([]);
  });

  test('keeps the newest unique topic and athlete entries with deterministic order', async () => {
    await updateShadowUserProfile('account-1', 'org-1', {
      topicAdded: 'new-topic',
      athleteIdDiscussed: 'athlete-new',
    });

    const topicSql = String(mockQuery.mock.calls[0][0]);
    const athleteSql = String(mockQuery.mock.calls[1][0]);
    expect(topicSql).toContain('WITH ORDINALITY');
    expect(topicSql).toContain('ORDER BY MAX(ordinality) DESC');
    expect(topicSql).toContain('LIMIT 10');
    expect(athleteSql).toContain('WITH ORDINALITY');
    expect(athleteSql).toContain('ORDER BY MAX(ordinality) DESC');
    expect(athleteSql).toContain('LIMIT 20');
    expect(mockQuery.mock.calls[0][1]).toEqual(['account-1', 'org-1', 'new-topic']);
    expect(mockQuery.mock.calls[1][1]).toEqual(['account-1', 'org-1', 'athlete-new']);
  });
});
