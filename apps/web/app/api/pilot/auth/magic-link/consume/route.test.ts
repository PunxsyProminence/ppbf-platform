/**
 * @jest-environment node
 */
import { GET, POST } from './route';

jest.mock('@/src/server/pilot/rateLimit', () => ({
  getClientIp: () => '203.0.113.9',
  checkRateLimit: jest.fn(() => ({ isLimited: false })),
  recordFailedAttempt: jest.fn(),
}));

import { checkRateLimit, recordFailedAttempt } from '@/src/server/pilot/rateLimit';

function post(body: unknown) {
  return POST({ json: async () => body, headers: new Headers() } as never);
}

describe('POST /api/pilot/auth/magic-link/consume', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (checkRateLimit as jest.Mock).mockReturnValue({ isLimited: false });
  });

  test('GET is refused with 405, not 404', async () => {
    // Mail scanners -- Safe Links, Defender, corporate gateways -- follow URLs
    // in messages with a GET. If GET consumed the token, the scanner would burn
    // it before the human ever clicked, and only for users whose provider
    // protects them best. 405 says "wrong method" rather than "wrong URL", so a
    // prefetch reads as a deliberate no-op instead of a routing bug.
    const response = await GET();
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });

  test('a missing token is refused with 400', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ token: '   ' })).status).toBe(400);
  });

  test('rate limits per IP before doing any lookup work', async () => {
    (checkRateLimit as jest.Mock).mockReturnValue({ isLimited: true });
    const response = await post({ token: 'anything' });
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ ok: false, reason: 'RATE_LIMITED' });
  });

  test('records an attempt on every redemption, not only failures', async () => {
    // The limiter has to sit in FRONT of the token lookup -- there is no
    // account to key on until the token resolves, and resolving it is the
    // expensive part. So every attempt counts, valid or not.
    await post({ token: 'some-token' });
    expect(recordFailedAttempt).toHaveBeenCalledWith('magic_link_consume_ip:203.0.113.9');
  });

  test('does not record an attempt for a malformed request', async () => {
    // A client bug sending no token should not consume anyone's rate budget.
    await post({});
    expect(recordFailedAttempt).not.toHaveBeenCalled();
  });
});
