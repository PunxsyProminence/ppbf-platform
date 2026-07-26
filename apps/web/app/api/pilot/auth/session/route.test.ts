import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { resolvePrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: jest.fn(),
}));

const mockResolvePrincipal = resolvePrincipal as jest.MockedFunction<typeof resolvePrincipal>;

afterEach(() => {
  jest.clearAllMocks();
});

function request(method: 'GET' | 'POST' = 'GET') {
  return new NextRequest('http://localhost/api/pilot/auth/session', { method });
}

describe('/api/pilot/auth/session', () => {
  test('returns the same authoritative contract for GET and POST', async () => {
    mockResolvePrincipal.mockResolvedValue({
      accountId: 'admin@punxsyprominence.org',
      role: 'platform_owner',
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token-1',
      authProvider: 'microsoft',
      hasMasterShadowAccess: true,
    });

    const getResponse = await GET(request('GET'));
    const postResponse = await POST(request('POST'));

    expect(getResponse.status).toBe(200);
    expect(postResponse.status).toBe(200);

    await expect(getResponse.json()).resolves.toMatchObject({
      authenticated: true,
      account_id: 'admin@punxsyprominence.org',
      role: 'platform_owner',
      organization_id: 'org-1',
      athlete_id: null,
      auth_provider: 'microsoft',
      authProvider: 'microsoft',
      has_master_shadow_access: true,
      hasMasterShadowAccess: true,
    });

    await expect(postResponse.json()).resolves.toMatchObject({
      authenticated: true,
      authProvider: 'microsoft',
    });
  });

  test('returns unauthenticated when no principal resolves', async () => {
    mockResolvePrincipal.mockResolvedValue(null);

    const response = await GET(request('GET'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authenticated: false });
  });
});