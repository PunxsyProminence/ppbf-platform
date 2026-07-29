jest.mock('./db', () => ({
  queryOne: jest.fn(),
}));

import { queryOne } from './db';
import {
  enforceShadowRateLimit,
  resolveShadowRateLimit,
  shadowRateLimitMessage,
  ShadowRateLimitExceeded,
} from './shadowRateLimit';

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

// These caps were literals at four call sites, so raising one that turned a real
// user away meant a code change and a release. Early pilot usage is the heaviest,
// and someone stopped in their first week does not come back -- so the caps have
// to be reachable from configuration, and the refusal has to say when they can
// continue.
describe('rate limits are tunable without a deploy', () => {
  test('falls back to the shipped default when unset or blank', () => {
    expect(resolveShadowRateLimit('chat_daily', {})).toEqual({
      endpointKey: 'chat_daily', limit: 400, windowSeconds: 86_400,
    });
    expect(resolveShadowRateLimit('chat_daily', { PPBF_SHADOW_RATE_LIMIT_CHAT_DAILY: '  ' }).limit).toBe(400);
  });

  test('an override raises the cap', () => {
    expect(resolveShadowRateLimit('chat_daily', {
      PPBF_SHADOW_RATE_LIMIT_CHAT_DAILY: '1200',
    }).limit).toBe(1_200);
  });

  test.each([
    ['not-a-number'], ['0'], ['-5'], [''],
  ])('a nonsense override %p cannot weaken or disable the cap', (raw) => {
    expect(resolveShadowRateLimit('chat', { PPBF_SHADOW_RATE_LIMIT_CHAT: raw }).limit).toBe(30);
  });

  // enforceShadowRateLimit rejects anything above 10_000, so the resolver must
  // clamp rather than hand it a value that would throw on every request.
  test('an absurd override is clamped to what the enforcer accepts', () => {
    const policy = resolveShadowRateLimit('chat', { PPBF_SHADOW_RATE_LIMIT_CHAT: '999999' });
    expect(policy.limit).toBe(10_000);
    expect(policy.limit).toBeLessThanOrEqual(10_000);
  });

  // The window is semantic: 'chat_daily' means a day. An override that changed
  // it would make the key a lie.
  test('an override cannot change the window', () => {
    expect(resolveShadowRateLimit('chat_daily', {
      PPBF_SHADOW_RATE_LIMIT_CHAT_DAILY: '50',
    }).windowSeconds).toBe(86_400);
  });

  test('every key resolves to a limit the enforcer will accept', () => {
    for (const key of ['chat', 'chat_daily', 'feedback', 'shadow_upload', 'video_upload'] as const) {
      const policy = resolveShadowRateLimit(key, {});
      expect(policy.endpointKey).toBe(key);
      expect(policy.limit).toBeGreaterThanOrEqual(1);
      expect(policy.limit).toBeLessThanOrEqual(10_000);
      expect(policy.windowSeconds).toBeLessThanOrEqual(86_400);
      expect(/^[a-z0-9:_-]{1,80}$/.test(policy.endpointKey)).toBe(true);
    }
  });
});

// "Please wait briefly" was accurate for the per-minute cap and wrong for the
// daily one, where briefly could mean twenty hours. Being told to wait briefly,
// waiting, and being refused again reads as a broken product.
describe('a refusal says when the caller can continue', () => {
  test('a short pause is described in seconds', () => {
    expect(shadowRateLimitMessage(18)).toContain('about 18 seconds');
  });

  test('a sub-hour wait is described in minutes', () => {
    expect(shadowRateLimitMessage(20 * 60)).toContain('about 20 minutes');
  });

  test('a daily cap is described as a cap that resets, not a brief wait', () => {
    const message = shadowRateLimitMessage(20 * 3_600);
    expect(message).toContain('usage limit');
    expect(message).toContain('about 20 hours');
    expect(message).not.toContain('Try again in about');
  });

  test('never tells the caller to retry sooner than the bucket allows', () => {
    for (const seconds of [1, 5, 45, 90, 91, 600, 3_600, 3_601, 86_400]) {
      const message = shadowRateLimitMessage(seconds);
      const stated = /about (\d+) (second|minute|hour)/.exec(message);
      expect(stated).not.toBeNull();
      const unit = { second: 1, minute: 60, hour: 3_600 }[stated![2] as 'second' | 'minute' | 'hour'];
      expect(Number(stated![1]) * unit).toBeGreaterThanOrEqual(Math.min(seconds, 5));
    }
  });

  test('names the subject so an upload refusal is not read as a chat refusal', () => {
    expect(shadowRateLimitMessage(30, 'video upload')).toContain('video upload');
  });
});
