import { NextRequest } from 'next/server';

import { POST } from './route';
import { resolvePrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: jest.fn(),
}));

const mockResolvePrincipal = jest.mocked(resolvePrincipal);

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/pilot/auth/session', () => {
  test('returns a non-cacheable unauthenticated response when the server session is absent or expired', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    const response = await POST(new NextRequest('https://ppbf.example/api/pilot/auth/session', {
      method: 'POST',
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ authenticated: false });
  });

  test('returns the authoritative role, organization, athlete, and provider from the server principal', async () => {
    mockResolvePrincipal.mockResolvedValueOnce({
      accountId: 'athlete-account',
      role: 'athlete',
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      sessionToken: 'opaque-token',
      authProvider: 'ppbf_local',
      hasMasterShadowAccess: false,
    });

    const response = await POST(new NextRequest('https://ppbf.example/api/pilot/auth/session', {
      method: 'POST',
    }));

    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      account_id: 'athlete-account',
      role: 'athlete',
      organization_id: 'org-1',
      athlete_id: 'athlete-1',
      auth_provider: 'ppbf_local',
    });
  });

  test('keeps server failures non-cacheable', async () => {
    mockResolvePrincipal.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await POST(new NextRequest('https://ppbf.example/api/pilot/auth/session', {
      method: 'POST',
    }));

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
