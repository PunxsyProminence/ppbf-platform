/**
 * @jest-environment node
 */
import { GET, POST } from './route';

jest.mock('@/src/server/pilot/rateLimit', () => ({
  getClientIp: () => '203.0.113.9',
  checkRateLimit: jest.fn(() => ({ isLimited: false })),
  recordFailedAttempt: jest.fn(),
}));

jest.mock('@/src/server/pilot/magicLinkStore', () => ({
  redeemMagicLink: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(async () => undefined),
}));

import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { redeemMagicLink } from '@/src/server/pilot/magicLinkStore';
import { checkRateLimit, recordFailedAttempt } from '@/src/server/pilot/rateLimit';

function post(body: unknown) {
  return POST({ json: async () => body, headers: new Headers() } as never);
}

const REDEEMED = {
  ok: true,
  session: { token: 'session-token-value', expiresAt: new Date('2026-08-09T00:00:00Z') },
  principal: { accountId: 'coach-1', organizationId: 'org-1', role: 'coach' as const },
};

describe('POST /api/pilot/auth/magic-link/consume', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (checkRateLimit as jest.Mock).mockReturnValue({ isLimited: false });
    (redeemMagicLink as jest.Mock).mockResolvedValue(REDEEMED);
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

  test('a successful redemption sets the session cookie', async () => {
    const response = await post({ token: 'good-token' });

    expect(response.status).toBe(200);
    const cookie = response.cookies.get('ppbf_pilot_session');
    expect(cookie?.value).toBe('session-token-value');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.path).toBe('/');
  });

  test('the redeemed token is the one that was sent', async () => {
    await post({ token: 'good-token' });
    expect(redeemMagicLink).toHaveBeenCalledWith('good-token');
  });

  test('a successful redemption writes a login audit event', async () => {
    await post({ token: 'good-token' });
    expect(writePilotAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'login',
        actor_account_id: 'coach-1',
        actor_role: 'coach',
        details: { auth_provider: 'magic_link' },
      }),
    );
  });

  test.each([
    'TOKEN_EXPIRED',
    'TOKEN_ALREADY_USED',
    'TOKEN_INVALIDATED',
    'ACCOUNT_INACTIVE',
    'EMAIL_CHANGED',
    'TOKEN_UNKNOWN',
  ])('a %s refusal returns 401 with the reason, and no cookie', async (reason) => {
    // The reason IS returned here, unlike the request route. Whoever holds a
    // link already knows the address it went to, so there is no enumeration to
    // protect -- and "this link expired, ask for a new one" is the difference
    // between a parent who retries and one who gives up.
    (redeemMagicLink as jest.Mock).mockResolvedValue({ ok: false, reason });

    const response = await post({ token: 'bad-token' });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, reason });
    expect(response.cookies.get('ppbf_pilot_session')).toBeUndefined();
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test('a redemption that reports ok but returns no session is refused', async () => {
    // Defensive: an inconsistent result must not produce a cookie-less 200
    // that the page reads as success.
    (redeemMagicLink as jest.Mock).mockResolvedValue({ ok: true });
    const response = await post({ token: 'weird' });
    expect(response.status).toBe(401);
    expect(response.cookies.get('ppbf_pilot_session')).toBeUndefined();
  });

  test('a missing token is refused with 400 and never reaches the store', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ token: '   ' })).status).toBe(400);
    expect(redeemMagicLink).not.toHaveBeenCalled();
  });

  test('rate limits per IP before doing any lookup work', async () => {
    (checkRateLimit as jest.Mock).mockReturnValue({ isLimited: true });
    const response = await post({ token: 'anything' });
    expect(response.status).toBe(429);
    expect(redeemMagicLink).not.toHaveBeenCalled();
  });

  test('records an attempt on every redemption, not only failures', async () => {
    // The limiter sits in FRONT of the token lookup -- there is no account to
    // key on until the token resolves, and resolving it is the expensive part.
    await post({ token: 'some-token' });
    expect(recordFailedAttempt).toHaveBeenCalledWith('magic_link_consume_ip:203.0.113.9');
  });

  test('does not record an attempt for a malformed request', async () => {
    await post({});
    expect(recordFailedAttempt).not.toHaveBeenCalled();
  });
});
