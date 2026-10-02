jest.mock('./db', () => ({
  queryOne: jest.fn(),
}));

import { queryOne } from './db';
import {
  consumeShadowRateLimit,
  consumeShadowReviewSlot,
  enforceShadowRateLimit,
  refundShadowRateLimit,
  resolveShadowRateLimit,
  resolveShadowReviewBucket,
  shadowRateLimitMessage,
  ShadowRateLimitExceeded,
  type ShadowRateLimitReceipt,
} from './shadowRateLimit';

const mockQueryOne = queryOne as jest.MockedFunction<typeof queryOne>;

describe('SHADOW durable rate limiting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('allows a request inside the authenticated account bucket', async () => {
    mockQueryOne.mockResolvedValueOnce({ request_count: 3, retry_after_seconds: 42, window_started_epoch: '1790000400' });

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
    mockQueryOne.mockResolvedValueOnce({ request_count: 21, retry_after_seconds: 18, window_started_epoch: '1790000400' });

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
    for (const key of [
      'chat', 'chat_daily', 'feedback', 'heavy_bag', 'shadow_upload', 'video_upload',
      'safety_review', 'safety_review_critical',
    ] as const) {
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

// The receipt and the refund. What the SQL does to real rows -- the right
// row, the right hour, never below zero, a refused attempt put back -- is
// shadowRateLimitRefund.pg.test.ts's subject, and several things here can
// only be proved there: these tests see the statement's text and parameters,
// not its effect. What they add is the shape of the calls and what happens
// when storage answers in ways a healthy database does not.
describe('the receipt: which bucket row a call charged', () => {
  const INPUT = { organizationId: 'org-1', accountId: 'account-1', endpointKey: 'safety_review', limit: 3, windowSeconds: 3_600 };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // OD-2026-09-30-005: "3 per hour"; OD-2026-10-01-006: two allowances.
  test.each(['safety_review', 'safety_review_critical'] as const)('%s is three an hour', (key) => {
    expect(resolveShadowRateLimit(key, {})).toEqual({ endpointKey: key, limit: 3, windowSeconds: 3_600 });
  });

  // UNLIKE every other bucket, these two cannot be moved by an environment
  // variable. Three an hour is the owner's number (OD-2026-10-01-006 section
  // 2); an operator's setting must not change it in either direction.
  test.each([
    ['raised', '6'],
    ['raised to the ceiling', '10000'],
    ['lowered', '1'],
  ])('an environment override does not move either review bucket: %s', (_name, value) => {
    const env = {
      PPBF_SHADOW_RATE_LIMIT_SAFETY_REVIEW: value,
      PPBF_SHADOW_RATE_LIMIT_SAFETY_REVIEW_CRITICAL: value,
    };
    expect(resolveShadowRateLimit('safety_review', env)).toEqual({ endpointKey: 'safety_review', limit: 3, windowSeconds: 3_600 });
    expect(resolveShadowRateLimit('safety_review_critical', env)).toEqual({ endpointKey: 'safety_review_critical', limit: 3, windowSeconds: 3_600 });
  });

  // CONTROL: the same override does move a bucket that is an operator's to tune.
  test('CONTROL: the same kind of override still moves an operator-tunable bucket', () => {
    expect(resolveShadowRateLimit('chat', { PPBF_SHADOW_RATE_LIMIT_CHAT: '6' }).limit).toBe(6);
  });

  test.each([
    ['the critical bucket', 'PPBF_SHADOW_RATE_LIMIT_SAFETY_REVIEW_CRITICAL', { kind: 'request_risk', critical: true }],
    ['the general bucket', 'PPBF_SHADOW_RATE_LIMIT_SAFETY_REVIEW', { kind: 'response_safety', critical: false }],
  ] as const)('the review slot is charged against three even when the environment asks for more: %s', async (_name, variable, event) => {
    const before = process.env[variable];
    process.env[variable] = '50';
    try {
      // The fourth in the hour: refused, whatever the environment says.
      mockQueryOne
        .mockResolvedValueOnce({ request_count: 4, retry_after_seconds: 1200, window_started_epoch: '1790000400' })
        .mockResolvedValueOnce({ request_count: 3 });
      await expect(consumeShadowReviewSlot({ organizationId: 'org-1', accountId: 'account-1', event }))
        .rejects.toBeInstanceOf(ShadowRateLimitExceeded);
    } finally {
      if (before === undefined) delete process.env[variable];
      else process.env[variable] = before;
      // A ...Once value left unconsumed by a failing run would be served to
      // the next test; clearAllMocks does not drop it.
      mockQueryOne.mockReset();
    }
  });

  test('a charge inside the limit returns the window the database chose, read back from the row', async () => {
    // pg hands a bigint back as a string.
    mockQueryOne.mockResolvedValueOnce({ request_count: 3, retry_after_seconds: 900, window_started_epoch: '1790000400' });

    await expect(consumeShadowRateLimit(INPUT)).resolves.toEqual({
      organizationId: 'org-1',
      accountId: 'account-1',
      endpointKey: 'safety_review',
      windowSeconds: 3_600,
      windowStartedAtEpochSeconds: 1_790_000_400,
    });
    expect(mockQueryOne.mock.calls[0][0]).toContain('extract(epoch from window_started_at)::bigint as window_started_epoch');
    expect(mockQueryOne.mock.calls[0][0]).toContain('returning request_count, window_started_at');
  });

  test('the fourth is refused, and the refusal names the row its attempt incremented', async () => {
    mockQueryOne.mockResolvedValueOnce({ request_count: 4, retry_after_seconds: 1200, window_started_epoch: '1790000400' });

    await expect(consumeShadowRateLimit(INPUT)).rejects.toEqual(expect.objectContaining({
      name: 'ShadowRateLimitExceeded',
      retryAfterSeconds: 1200,
      endpointKey: 'safety_review',
      receipt: {
        organizationId: 'org-1',
        accountId: 'account-1',
        endpointKey: 'safety_review',
        windowSeconds: 3_600,
        windowStartedAtEpochSeconds: 1_790_000_400,
      },
    }));
  });

  test('a refusal whose window cannot be read is still a refusal, with no receipt', async () => {
    mockQueryOne.mockResolvedValueOnce({ request_count: 4, retry_after_seconds: 1200, window_started_epoch: 'not-a-number' } as never);

    const refused = consumeShadowRateLimit(INPUT);
    await expect(refused).rejects.toBeInstanceOf(ShadowRateLimitExceeded);
    await expect(refused).rejects.toEqual(expect.objectContaining({ receipt: undefined }));
  });

  test('storage that answers with no row, or with no usable window, is UNAVAILABLE and not "exceeded"', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(consumeShadowRateLimit(INPUT)).rejects.toThrow('SHADOW_RATE_LIMIT_UNAVAILABLE');

    mockQueryOne.mockResolvedValueOnce({ request_count: 1, retry_after_seconds: 10, window_started_epoch: 'not-a-number' } as never);
    const noWindow = consumeShadowRateLimit(INPUT);
    await expect(noWindow).rejects.toThrow('SHADOW_RATE_LIMIT_UNAVAILABLE');
    await expect(noWindow).rejects.not.toBeInstanceOf(ShadowRateLimitExceeded);

    mockQueryOne.mockRejectedValueOnce(new Error('connection refused'));
    const down = consumeShadowRateLimit(INPUT);
    await expect(down).rejects.toThrow('connection refused');
    await expect(down).rejects.not.toBeInstanceOf(ShadowRateLimitExceeded);
  });

  test('enforceShadowRateLimit is the same charge with the receipt dropped: one query, and it admits and refuses alike', async () => {
    mockQueryOne.mockResolvedValueOnce({ request_count: 1, retry_after_seconds: 10, window_started_epoch: '1790000400' });
    await expect(enforceShadowRateLimit(INPUT)).resolves.toBeUndefined();
    expect(mockQueryOne).toHaveBeenCalledTimes(1);

    mockQueryOne.mockResolvedValueOnce({ request_count: 4, retry_after_seconds: 1200, window_started_epoch: '1790000400' });
    await expect(enforceShadowRateLimit(INPUT)).rejects.toBeInstanceOf(ShadowRateLimitExceeded);

    mockQueryOne.mockResolvedValueOnce(null);
    await expect(enforceShadowRateLimit(INPUT)).rejects.toThrow('SHADOW_RATE_LIMIT_UNAVAILABLE');
  });

  // The receipt is new; the chat, upload and Heavy Bag limits do not use it.
  // A window that cannot be read back must not start refusing THEIR callers:
  // before receipts existed that column was not selected at all.
  test('enforceShadowRateLimit does not fail for want of a receipt', async () => {
    mockQueryOne.mockResolvedValueOnce({ request_count: 1, retry_after_seconds: 10, window_started_epoch: 'not-a-number' } as never);
    await expect(enforceShadowRateLimit(INPUT)).resolves.toBeUndefined();
  });
});

// WHICH ALLOWANCE A REVIEW ROW DRAWS ON (OD-2026-10-01-006, the owner's "A").
describe('the review buckets: critical request reviews have their own allowance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([
    ['a critical request review', { kind: 'request_risk', critical: true }, 'safety_review_critical'],
    ['any other high-risk request review', { kind: 'request_risk', critical: false }, 'safety_review'],
    ['a generated-answer review', { kind: 'response_safety', critical: false }, 'safety_review'],
    // The answer to a critical request is still an answer: it does not draw on the critical allowance.
    ['a generated-answer review behind a critical request', { kind: 'response_safety', critical: true }, 'safety_review'],
    ['an operational row, such as the empty-Library notice', { kind: 'operational', critical: false }, 'safety_review'],
    ['an operational row behind a critical request', { kind: 'operational', critical: true }, 'safety_review'],
  ] as const)('%s draws on %s', (_name, event, bucket) => {
    expect(resolveShadowReviewBucket(event)).toBe(bucket);
  });

  const ask = (event: Parameters<typeof resolveShadowReviewBucket>[0]) => consumeShadowReviewSlot({
    organizationId: 'org-1',
    accountId: 'account-1',
    event,
  });

  test.each([
    [{ kind: 'request_risk', critical: true }, 'safety_review_critical'],
    [{ kind: 'response_safety', critical: true }, 'safety_review'],
  ] as const)('an admitted row is charged to its bucket for this account and its receipt returned: %j', async (event, bucket) => {
    mockQueryOne.mockResolvedValueOnce({ request_count: 3, retry_after_seconds: 900, window_started_epoch: '1790000400' });

    await expect(ask(event)).resolves.toEqual({
      organizationId: 'org-1',
      accountId: 'account-1',
      endpointKey: bucket,
      windowSeconds: 3_600,
      windowStartedAtEpochSeconds: 1_790_000_400,
    });
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['org-1', 'account-1', bucket, 3_600]);
  });

  test('a refused attempt is put back: the row it incremented, once, and the refusal still reaches the caller', async () => {
    mockQueryOne
      .mockResolvedValueOnce({ request_count: 4, retry_after_seconds: 1200, window_started_epoch: '1790000400' })
      .mockResolvedValueOnce({ request_count: 3 });

    await expect(ask({ kind: 'request_risk', critical: true })).rejects.toBeInstanceOf(ShadowRateLimitExceeded);

    expect(mockQueryOne).toHaveBeenCalledTimes(2);
    const [sql, params] = mockQueryOne.mock.calls[1];
    expect(sql).toContain('set request_count = request_count - 1');
    expect(params).toEqual(['org-1', 'account-1', 'safety_review_critical', 1_790_000_400, 3_600]);
  });

  test('if putting it back fails, the caller is still told the hour is spent, not that the limiter failed', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mockQueryOne
        .mockResolvedValueOnce({ request_count: 4, retry_after_seconds: 1200, window_started_epoch: '1790000400' })
        .mockRejectedValueOnce(new Error('connection refused'));

      await expect(ask({ kind: 'response_safety', critical: false })).rejects.toBeInstanceOf(ShadowRateLimitExceeded);
    } finally {
      quiet.mockRestore();
    }
  });

  test('an admitted charge whose window cannot be read back is a limiter failure, not an admission and not "spent"', async () => {
    mockQueryOne.mockResolvedValueOnce({ request_count: 1, retry_after_seconds: 10, window_started_epoch: 'not-a-number' } as never);

    const unreadable = ask({ kind: 'request_risk', critical: true });
    await expect(unreadable).rejects.toThrow('SHADOW_RATE_LIMIT_UNAVAILABLE');
    await expect(unreadable).rejects.not.toBeInstanceOf(ShadowRateLimitExceeded);
  });

  test('a limiter that fails is not a limiter that is spent, and nothing is put back', async () => {
    mockQueryOne.mockRejectedValueOnce(new Error('connection refused'));

    const failed = ask({ kind: 'request_risk', critical: false });
    await expect(failed).rejects.toThrow('connection refused');
    await expect(failed).rejects.not.toBeInstanceOf(ShadowRateLimitExceeded);
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
  });
});

describe('the refund: give back the one slot a receipt names', () => {
  const RECEIPT: ShadowRateLimitReceipt = {
    organizationId: 'org-1',
    accountId: 'account-1',
    endpointKey: 'safety_review',
    windowSeconds: 3_600,
    windowStartedAtEpochSeconds: 1_790_000_400,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("it names the receipt's own window, and does not work out a window from the clock", async () => {
    mockQueryOne.mockResolvedValueOnce({ request_count: 2 });

    await expect(refundShadowRateLimit(RECEIPT)).resolves.toBe(true);

    const [sql, params] = mockQueryOne.mock.calls[0];
    expect(params).toEqual(['org-1', 'account-1', 'safety_review', 1_790_000_400, 3_600]);
    expect(sql).toContain('window_started_at = to_timestamp($4::bigint)');
    expect(sql).toContain('window_seconds = $5');
    expect(sql).toContain('request_count > 0');
    // The earlier refund worked out "the current window" here. This one must not.
    expect(sql).not.toContain('clock_timestamp');
    expect(sql).not.toMatch(/insert/i);
  });

  test('no matching row: false', async () => {
    mockQueryOne.mockResolvedValueOnce(null);
    await expect(refundShadowRateLimit(RECEIPT)).resolves.toBe(false);
  });

  test('a malformed receipt is refused before storage is touched', async () => {
    for (const bad of [
      { ...RECEIPT, organizationId: '  ' },
      { ...RECEIPT, accountId: '' },
      { ...RECEIPT, endpointKey: 'chat;drop' },
      { ...RECEIPT, windowSeconds: 0 },
      { ...RECEIPT, windowSeconds: 86_401 },
      { ...RECEIPT, windowStartedAtEpochSeconds: 1.5 },
      { ...RECEIPT, windowStartedAtEpochSeconds: -1 },
    ]) {
      await expect(refundShadowRateLimit(bad)).resolves.toBe(false);
    }
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('it never throws: a failing database comes back false, and the log carries no detail', async () => {
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      mockQueryOne.mockRejectedValueOnce(new Error('relation "pilot.shadow_rate_limit_buckets" does not exist'));
      await expect(refundShadowRateLimit(RECEIPT)).resolves.toBe(false);
      expect(quiet).toHaveBeenCalledWith('SHADOW rate-limit refund failed');
    } finally {
      quiet.mockRestore();
    }
  });
});
