import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { readPaymentPlatformConfig } from '@/src/server/pilot/paymentConnect';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/paymentConnect', () => {
  const actual = jest.requireActual('@/src/server/pilot/paymentConnect');
  return { ...actual, readPaymentPlatformConfig: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockConfig = readPaymentPlatformConfig as jest.Mock;

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
  new NextRequest(`https://gym.example/api/pilot/payments/connect/start?${query}`);

test('a coach cannot start a connect -- settlement accounts are admin work', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));

  expect((await GET(getRequest('lane=giving'))).status).toBeGreaterThanOrEqual(400);
});

test('an unknown lane is a 400, not a redirect', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockConfig.mockReturnValue({ connectClientId: 'ca_1', platformSecretKey: 'sk_1', webhookSecret: null });

  expect((await GET(getRequest('lane=general'))).status).toBe(400);
});

test('an unregistered platform answers honestly instead of redirecting nowhere', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockConfig.mockReturnValue({ connectClientId: null, platformSecretKey: null, webhookSecret: null });

  const response = await GET(getRequest('lane=giving'));
  const payload = await response.json();

  expect(response.status).toBe(503);
  expect(payload.error).toMatch(/not registered yet/i);
});

test('a configured platform redirects to Stripe with the org-bound state', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockConfig.mockReturnValue({ connectClientId: 'ca_1', platformSecretKey: 'sk_signing', webhookSecret: null });

  const response = await GET(getRequest('lane=giving'));

  expect(response.status).toBe(302);
  const location = new URL(response.headers.get('location') ?? '');
  expect(location.origin + location.pathname).toBe('https://connect.stripe.com/oauth/authorize');
  expect(location.searchParams.get('client_id')).toBe('ca_1');
  expect(location.searchParams.get('redirect_uri')).toBe('https://gym.example/api/pilot/payments/connect/callback');
  // The state is verifiable with the same key and names the caller's org.
  const { verifyConnectState } = jest.requireActual('@/src/server/pilot/paymentConnect');
  const claims = verifyConnectState(location.searchParams.get('state') ?? '', 'sk_signing');
  expect(claims).toMatchObject({ organizationId: 'org-1', lane: 'giving' });
});
