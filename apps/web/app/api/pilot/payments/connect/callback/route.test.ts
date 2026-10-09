import { NextRequest } from 'next/server';

import { GET } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  CONNECT_NONCE_COOKIE,
  exchangeCodeForAccountId,
  readPaymentPlatformConfig,
  signConnectState,
  upsertConnectedAccount,
} from '@/src/server/pilot/paymentConnect';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

jest.mock('@/src/server/pilot/paymentConnect', () => {
  const actual = jest.requireActual('@/src/server/pilot/paymentConnect');
  return {
    ...actual,
    readPaymentPlatformConfig: jest.fn(),
    exchangeCodeForAccountId: jest.fn(),
    upsertConnectedAccount: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockConfig = readPaymentPlatformConfig as jest.Mock;
const mockExchange = exchangeCodeForAccountId as jest.Mock;
const mockUpsert = upsertConnectedAccount as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

const SIGNING_KEY = 'sk_signing';

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const NONCE = 'nonce-1';

// The browser that started the connect carries the one-time nonce cookie
// back on Stripe's top-level redirect (SameSite=Lax permits it).
const getRequest = (query: string, cookieNonce: string | null = NONCE) =>
  new NextRequest(`https://gym.example/api/pilot/payments/connect/callback?${query}`, {
    headers: cookieNonce === null ? {} : { cookie: `${CONNECT_NONCE_COOKIE}=${cookieNonce}` },
  });

function stateFor(organizationId: string, lane: 'giving' | 'program', overrides: Record<string, string> = {}): string {
  return signConnectState(
    { organizationId, lane, accountId: 'acct-1', sessionToken: 'token', nonce: NONCE, ...overrides },
    SIGNING_KEY,
  );
}

function clearsNonceCookie(response: Response): boolean {
  const header = response.headers.get('set-cookie') ?? '';
  return header.includes(`${CONNECT_NONCE_COOKIE}=;`) && /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(header);
}

function configured() {
  mockConfig.mockReturnValue({ connectClientId: 'ca_1', platformSecretKey: SIGNING_KEY, webhookSecret: null });
}

test('a valid round trip stores the account under the state-named lane and audits it', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  configured();
  mockExchange.mockResolvedValue('acct_new_1');
  mockUpsert.mockResolvedValue({ stripe_account_id: 'acct_new_1' });
  const state = stateFor('org-1', 'giving');

  const response = await GET(getRequest(`code=code-1&state=${encodeURIComponent(state)}`));

  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toContain('/admin/payments?connect=ok&lane=giving');
  expect(mockUpsert).toHaveBeenCalledWith({
    organizationId: 'org-1',
    lane: 'giving',
    stripeAccountId: 'acct_new_1',
    connectedByAccountId: 'acct-1',
  });
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    event_type: 'payment_account_connected',
    organization_id: 'org-1',
  }));
});

// Previously an unguarded writePilotAuditEvent: upsertConnectedAccount had
// already committed the connection by the time this ran, so a throw here
// fell through to jsonError(), which always returns NextResponse.json(...)
// -- never a redirect -- to what is a full-page browser navigation from
// Stripe. The admin would see raw JSON with no way back to /admin/payments
// and no way to tell the connection actually succeeded.
test('an audit-write failure still redirects with the real outcome, not raw JSON', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  configured();
  mockExchange.mockResolvedValue('acct_new_1');
  mockUpsert.mockResolvedValue({ stripe_account_id: 'acct_new_1' });
  mockAudit.mockRejectedValueOnce(new Error('connection pool exhausted'));
  const state = stateFor('org-1', 'giving');

  const response = await GET(getRequest(`code=code-1&state=${encodeURIComponent(state)}`));

  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toContain('/admin/payments?connect=ok&lane=giving');
});

test("another organization's state cannot attach an account here", async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-2' }));
  configured();
  const state = stateFor('org-1', 'giving');

  const response = await GET(getRequest(`code=code-1&state=${encodeURIComponent(state)}`));

  expect(response.headers.get('location')).toContain('connect=state-mismatch');
  expect(mockExchange).not.toHaveBeenCalled();
  expect(mockUpsert).not.toHaveBeenCalled();
});

test('a tampered state never reaches the exchange', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  configured();

  const response = await GET(getRequest('code=code-1&state=forged.state'));

  expect(response.headers.get('location')).toContain('connect=state-mismatch');
  expect(mockExchange).not.toHaveBeenCalled();
});

test('a denial on Stripe lands back with the outcome named and stores nothing', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  configured();

  const response = await GET(getRequest('error=access_denied'));

  expect(response.headers.get('location')).toContain('connect=denied');
  expect(mockUpsert).not.toHaveBeenCalled();
});

test('a refused exchange lands back with the outcome named', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  configured();
  mockExchange.mockRejectedValue(new Error('PAYMENT_CONNECT_EXCHANGE_FAILED: invalid_grant'));
  const state = stateFor('org-1', 'program');

  const response = await GET(getRequest(`code=stale&state=${encodeURIComponent(state)}`));

  expect(response.headers.get('location')).toContain('connect=exchange-failed');
  expect(mockUpsert).not.toHaveBeenCalled();
});

test('a coach cannot complete a connect', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  configured();

  expect((await GET(getRequest('code=code-1&state=x'))).status).toBeGreaterThanOrEqual(400);
});

// Audit slice A, Q5 / owner ruling 2026-10-05: the state must be single-use
// and bound to the session that started the flow.
describe('the connect state is single-use and bound to the starting session', () => {
  beforeEach(() => {
    configured();
    mockExchange.mockResolvedValue('acct_new_1');
    mockUpsert.mockResolvedValue({ stripe_account_id: 'acct_new_1' });
  });

  test('a successful callback clears the nonce cookie, so the same state is refused the second time', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    const state = stateFor('org-1', 'giving');

    const first = await GET(getRequest(`code=code-1&state=${encodeURIComponent(state)}`));
    expect(first.headers.get('location')).toContain('connect=ok');
    expect(clearsNonceCookie(first)).toBe(true);

    // The browser has applied that clear: the replay arrives without the nonce.
    const replay = await GET(getRequest(`code=code-1&state=${encodeURIComponent(state)}`, null));
    expect(replay.headers.get('location')).toContain('connect=state-mismatch');
    expect(mockExchange).toHaveBeenCalledTimes(1);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
  });

  test('another admin of the same organization cannot complete a connect someone else started', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-2' }));
    const state = stateFor('org-1', 'giving');

    const response = await GET(getRequest(`code=code-1&state=${encodeURIComponent(state)}`));

    expect(response.headers.get('location')).toContain('connect=state-mismatch');
    expect(mockExchange).not.toHaveBeenCalled();
  });

  test('the same admin on another session cannot complete it', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ sessionToken: 'other-token' }));
    const state = stateFor('org-1', 'giving');

    const response = await GET(getRequest(`code=code-1&state=${encodeURIComponent(state)}`));

    expect(response.headers.get('location')).toContain('connect=state-mismatch');
    expect(mockExchange).not.toHaveBeenCalled();
  });

  test('a mismatched nonce cookie is refused, and the refusal still clears the cookie', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    const state = stateFor('org-1', 'giving');

    const response = await GET(getRequest(`code=code-1&state=${encodeURIComponent(state)}`, 'nonce-other'));

    expect(response.headers.get('location')).toContain('connect=state-mismatch');
    expect(clearsNonceCookie(response)).toBe(true);
    expect(mockExchange).not.toHaveBeenCalled();
  });
});
