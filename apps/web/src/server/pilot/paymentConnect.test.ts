// The connect flow's pure mechanics: the signed OAuth state (what stops a
// forged or replayed redirect from attaching a Stripe account to an
// organization that never asked), the authorize URL, the token exchange
// (mocked network -- nothing here talks to Stripe), and the webhook
// signature scheme with its freshness window.

import { createHmac } from 'node:crypto';

import {
  buildAuthorizeUrl,
  connectStateBindsTo,
  exchangeCodeForAccountId,
  signConnectState,
  verifyConnectState,
  verifyStripeWebhookSignature,
} from './paymentConnect';

const KEY = 'sk_test_signing_key';
const NOW = 1_800_000_000;
const BINDING_GIVING = {
  organizationId: 'org-1',
  lane: 'giving',
  accountId: 'acct-1',
  sessionToken: 'session-token-1',
  nonce: 'nonce-1',
} as const;

describe('connect state', () => {
  test('round-trips the organization and lane', () => {
    const state = signConnectState(BINDING_GIVING, KEY, NOW);
    const claims = verifyConnectState(state, KEY, NOW);

    expect(claims).toMatchObject({ organizationId: 'org-1', lane: 'giving' });
  });

  test('a tampered payload is refused, not partially trusted', () => {
    const state = signConnectState(BINDING_GIVING, KEY, NOW);
    const [payload, signature] = state.split('.');
    const forged = `${Buffer.from(
      JSON.stringify({ organizationId: 'org-attacker', lane: 'giving', expiresAtEpochSeconds: NOW + 999 }),
    ).toString('base64url')}.${signature}`;

    expect(verifyConnectState(forged, KEY, NOW)).toBeNull();
    expect(payload).not.toBe('');
  });

  test('an expired state is refused -- a leaked link goes stale', () => {
    const state = signConnectState({ ...BINDING_GIVING, lane: 'program' }, KEY, NOW);

    expect(verifyConnectState(state, KEY, NOW + 31 * 60)).toBeNull();
  });

  test('a state signed with a different key is refused', () => {
    const state = signConnectState(BINDING_GIVING, 'other-key', NOW);

    expect(verifyConnectState(state, KEY, NOW)).toBeNull();
  });

  test('the state never carries the raw session token', () => {
    const state = signConnectState(BINDING_GIVING, KEY, NOW);
    const payload = Buffer.from(state.split('.')[0], 'base64url').toString('utf8');

    expect(payload).not.toContain('session-token-1');
  });
});

// Standard OAuth state handling: the state is bound to the admin and the
// browser session that started the connect, and to a one-time nonce held in
// that browser's cookie. Same organization is not enough.
describe('connect state binding', () => {
  const claims = () => verifyConnectState(signConnectState(BINDING_GIVING, KEY, NOW), KEY, NOW)!;
  const caller = { organizationId: 'org-1', accountId: 'acct-1', sessionToken: 'session-token-1', cookieNonce: 'nonce-1' };

  test('binds to the account, session and nonce that started it', () => {
    expect(connectStateBindsTo(claims(), caller)).toBe(true);
  });

  test.each([
    ['another organization', { organizationId: 'org-2' }],
    ['another admin of the same organization', { accountId: 'acct-2' }],
    ['another session of the same admin', { sessionToken: 'session-token-2' }],
    ['no nonce cookie (already used, or another browser)', { cookieNonce: null }],
    ['a different nonce cookie', { cookieNonce: 'nonce-2' }],
  ])('refuses %s', (_label, override) => {
    expect(connectStateBindsTo(claims(), { ...caller, ...override })).toBe(false);
  });
});

describe('authorize URL', () => {
  test('carries the client id, state, scope, and redirect', () => {
    const url = new URL(buildAuthorizeUrl({
      connectClientId: 'ca_test_123',
      state: 'the-state',
      redirectUri: 'https://gym.example/api/pilot/payments/connect/callback',
    }));

    expect(url.origin + url.pathname).toBe('https://connect.stripe.com/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('ca_test_123');
    expect(url.searchParams.get('state')).toBe('the-state');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe('https://gym.example/api/pilot/payments/connect/callback');
  });
});

describe('code exchange', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns the connected account id and sends the platform secret server-side', async () => {
    const seen: { body?: string } = {};
    global.fetch = jest.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      seen.body = String(init?.body);
      return { ok: true, json: async () => ({ stripe_user_id: 'acct_connected_1' }) } as Response;
    }) as unknown as typeof fetch;

    const accountId = await exchangeCodeForAccountId('code-1', 'sk_platform');

    expect(accountId).toBe('acct_connected_1');
    expect(seen.body).toContain('grant_type=authorization_code');
    expect(seen.body).toContain('client_secret=sk_platform');
  });

  test('a refused exchange throws the named error', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant', error_description: 'Code expired' }),
    })) as unknown as typeof fetch;

    await expect(exchangeCodeForAccountId('stale', 'sk_platform'))
      .rejects.toThrow(/PAYMENT_CONNECT_EXCHANGE_FAILED/);
  });
});

describe('webhook signature', () => {
  const SECRET = 'whsec_test';

  function sign(body: string, timestamp: number): string {
    const v1 = createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
    return `t=${timestamp},v1=${v1}`;
  }

  test('a correctly signed fresh payload verifies', () => {
    const body = '{"type":"account.application.deauthorized"}';

    expect(verifyStripeWebhookSignature(body, sign(body, NOW), SECRET, NOW)).toBe(true);
  });

  test('a stale timestamp is refused even with a valid signature -- no replays', () => {
    const body = '{"type":"account.application.deauthorized"}';

    expect(verifyStripeWebhookSignature(body, sign(body, NOW - 6 * 60), SECRET, NOW)).toBe(false);
  });

  test('a signature over a different body is refused', () => {
    expect(verifyStripeWebhookSignature('{"tampered":true}', sign('{"original":true}', NOW), SECRET, NOW)).toBe(false);
  });

  test('a missing header is refused', () => {
    expect(verifyStripeWebhookSignature('{}', null, SECRET, NOW)).toBe(false);
  });
});
