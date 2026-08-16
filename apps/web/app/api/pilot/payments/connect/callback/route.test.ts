import { NextRequest } from 'next/server';

import { GET } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
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

const getRequest = (query: string) =>
  new NextRequest(`https://gym.example/api/pilot/payments/connect/callback?${query}`);

function configured() {
  mockConfig.mockReturnValue({ connectClientId: 'ca_1', platformSecretKey: SIGNING_KEY, webhookSecret: null });
}

test('a valid round trip stores the account under the state-named lane and audits it', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  configured();
  mockExchange.mockResolvedValue('acct_new_1');
  mockUpsert.mockResolvedValue({ stripe_account_id: 'acct_new_1' });
  const state = signConnectState({ organizationId: 'org-1', lane: 'giving' }, SIGNING_KEY);

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

test("another organization's state cannot attach an account here", async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-2' }));
  configured();
  const state = signConnectState({ organizationId: 'org-1', lane: 'giving' }, SIGNING_KEY);

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
  const state = signConnectState({ organizationId: 'org-1', lane: 'program' }, SIGNING_KEY);

  const response = await GET(getRequest(`code=stale&state=${encodeURIComponent(state)}`));

  expect(response.headers.get('location')).toContain('connect=exchange-failed');
  expect(mockUpsert).not.toHaveBeenCalled();
});

test('a coach cannot complete a connect', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  configured();

  expect((await GET(getRequest('code=code-1&state=x'))).status).toBeGreaterThanOrEqual(400);
});
