jest.mock('./db', () => ({
  queryOne: jest.fn(),
}));

import { queryOne } from './db';
import { enforceShadowRateLimit, ShadowRateLimitExceeded } from './shadowRateLimit';

const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;

describe('SHADOW durable rate limiting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('allows a request inside the authenticated account bucket', async () => {
    mockQueryOne.mockResolvedValueOnce({ request_count: 3, retry_after_seconds: 42 });

    await expect(enforceShadowRateLimit({
      organizationId: 'org-1',
      accountId: 'account-1',
      endpointKey: 'chat',
      limit: 20,
      windowSeconds: 60,
    })).resolves.toBeUndefined();

    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('shadow_rate_limit_buckets'),
      ['org-1', 'account-1', 'chat', 60],
    );
    expect(mockQueryOne.mock.calls[0][0]).toContain("interval '2 days'");
    expect(mockQueryOne.mock.calls[0][0]).toContain('limit 250');
  });

  test('fails with a bounded retry time when the bucket is over limit', async () => {
    mockQueryOne.mockResolvedValueOnce({ request_count: 21, retry_after_seconds: 18 });

    await expect(enforceShadowRateLimit({
      organizationId: 'org-1',
      accountId: 'account-1',
      endpointKey: 'chat',
      limit: 20,
      windowSeconds: 60,
    })).rejects.toEqual(expect.objectContaining<Partial<ShadowRateLimitExceeded>>({
      message: 'SHADOW_RATE_LIMIT_EXCEEDED',
      retryAfterSeconds: 18,
    }));
  });

  test('rejects invalid bucket configuration before touching storage', async () => {
    await expect(enforceShadowRateLimit({
      organizationId: 'org-1',
      accountId: 'account-1',
      endpointKey: 'chat;drop',
      limit: 20,
      windowSeconds: 60,
    })).rejects.toThrow('Invalid SHADOW rate-limit endpoint');
    expect(mockQueryOne).not.toHaveBeenCalled();
  });
});
