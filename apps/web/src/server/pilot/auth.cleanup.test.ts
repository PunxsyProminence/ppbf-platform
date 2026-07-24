jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

import { cleanupExpiredSessions } from './auth';
import { query } from './db';

const mockQuery = query as jest.Mock;

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

  test('defaults to a 7-day retention window', async () => {
    mockQuery.mockResolvedValueOnce([]);
    await cleanupExpiredSessions();
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual([7]);
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
