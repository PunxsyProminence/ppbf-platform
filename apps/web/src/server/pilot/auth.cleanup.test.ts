jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { cleanupExpiredSessions, countExpiredSessions } from './auth';
import { query, queryOne } from './db';

const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

describe('cleanupExpiredSessions', () => {
  test('deletes rows past the retention window for either expiry or revocation, and reports the count', async () => {
    mockQuery.mockResolvedValueOnce([{ token_hash: 'a' }, { token_hash: 'b' }]);

    const result = await cleanupExpiredSessions(7);

    expect(result).toEqual({ deletedCount: 2 });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('delete from pilot.session_tokens');
    expect(sql).toContain('expires_at <');
    expect(sql).toContain('revoked_at is not null');
    expect(params).toEqual([7]);
  });

  // docs/DATA_RETENTION.md: "Session tokens | 30 days after expiration/revocation".
  test('defaults to the 30-day window the retention policy states', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await cleanupExpiredSessions();
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([30]);
  });

  test('reports zero when nothing is old enough to delete', async () => {
    mockQuery.mockResolvedValueOnce([]);
    const result = await cleanupExpiredSessions(30);
    expect(result).toEqual({ deletedCount: 0 });
  });

  // Validated at this service boundary too, not only by the CLI wrapper, so
  // any caller gets the same rejection.
  test.each([0, -1, Number.NaN, 1.5, 10000])('rejects an invalid retentionDays value: %s', async (invalid) => {
    await expect(cleanupExpiredSessions(invalid)).rejects.toThrow('Invalid retention days');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('countExpiredSessions', () => {
  test('counts with the same predicate the delete uses, and deletes nothing', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await cleanupExpiredSessions(30);
    const deleteSql = mockQuery.mock.calls[0][0] as string;

    mockQueryOne.mockResolvedValueOnce({ n: 3 });
    expect(await countExpiredSessions()).toEqual({ dueCount: 3 });
    const [countSql, params] = mockQueryOne.mock.calls[0];
    expect(countSql).not.toContain('delete');
    expect(params).toEqual([30]);
    const where = (sql: string) => sql.slice(sql.indexOf('where')).replace(/returning[\s\S]*$/, '').trim();
    expect(where(countSql)).toBe(where(deleteSql));
  });

  test.each([0, -1, 1.5, 10000])('rejects an invalid retentionDays value: %s', async (invalid) => {
    await expect(countExpiredSessions(invalid)).rejects.toThrow('Invalid retention days');
    expect(mockQueryOne).not.toHaveBeenCalled();
  });
});
