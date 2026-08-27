import { NextRequest } from 'next/server';

import { POST } from './route';
import { provisionAthleteActivation } from '@/src/server/pilot/activation';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/activation', () => ({
  provisionAthleteActivation: jest.fn().mockResolvedValue({ code: 'ABCD-2345-EFGH', expiresAt: '2026-08-26T00:00:00Z' }),
}));

jest.mock('@/src/server/pilot/http', () => ({
  requireMicrosoftAuthenticatedPrincipal: jest.fn(),
  jsonError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Unauthorized')) return new Response(JSON.stringify({ error: message }), { status: 401 });
    if (message.startsWith('Forbidden')) return new Response(JSON.stringify({ error: message }), { status: 403 });
    if (message.startsWith('Missing') || message.startsWith('PIN')) return new Response(JSON.stringify({ error: message }), { status: 400 });
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  },
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequireMicrosoftAuthenticatedPrincipal = requireMicrosoftAuthenticatedPrincipal as jest.Mock;
const mockReset = provisionAthleteActivation as jest.Mock;

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/admin/accounts/pin-reset', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/pilot/admin/accounts/pin-reset', () => {
  test('denies PIN-auth sessions for privileged PIN-management actions', async () => {
    mockRequireMicrosoftAuthenticatedPrincipal.mockRejectedValueOnce(new Error('Forbidden: Microsoft-authenticated session required'));

    const response = await POST(makeRequest({ account_id: 'ath-1', pin: '123456', mode: 'reset' }));
    expect(response.status).toBe(403);
    expect(mockReset).not.toHaveBeenCalled();
  });

  test('requires an authenticated organization admin', async () => {
    mockRequireMicrosoftAuthenticatedPrincipal.mockResolvedValueOnce({
      accountId: 'coach-1',
      role: 'coach',
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'ppbf_local',
    });

    const response = await POST(makeRequest({ account_id: 'ath-1', pin: '123456', mode: 'reset' }));
    expect(response.status).toBe(403);
    expect(mockReset).not.toHaveBeenCalled();
  });

  test('reissues a one-time code only within principal organization scope', async () => {
    mockRequireMicrosoftAuthenticatedPrincipal.mockResolvedValueOnce({
      accountId: 'admin@punxsyprominence.org',
      role: 'organization_admin',
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'microsoft',
    });

    const response = await POST(makeRequest({ account_id: 'ath-account-1' }));

    expect(response.status).toBe(200);
    expect(mockReset).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'ath-account-1', organizationId: 'org-1', mode: 'reset' }));
  });

  test('resets PIN and revokes sessions via auth service', async () => {
    mockRequireMicrosoftAuthenticatedPrincipal.mockResolvedValueOnce({
      accountId: 'admin@punxsyprominence.org',
      role: 'organization_admin',
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'microsoft',
    });

    const response = await POST(makeRequest({ account_id: 'ath-account-2', pin: '123456', mode: 'reset' }));

    expect(response.status).toBe(200);
    expect(mockReset).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'ath-account-2', organizationId: 'org-1', mode: 'reset' }));
  });

  test('the legacy admin alias is still accepted', async () => {
    mockRequireMicrosoftAuthenticatedPrincipal.mockResolvedValueOnce({
      accountId: 'legacy-admin-1',
      role: 'admin',
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'microsoft',
    });

    const response = await POST(makeRequest({ account_id: 'ath-account-3', pin: '123456', mode: 'reset' }));

    expect(response.status).toBe(200);
    expect(mockReset).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'ath-account-3', organizationId: 'org-1', mode: 'reset' }));
  });

  test.each(['activate', 'reset'])('refuses the platform owner: %s', async (mode) => {
    // Athlete credentials are excluded from the platform owner tier, matching
    // session revocation. Omega gathers data and supports organization admins;
    // it does not hold an individual athlete's sign-in.
    mockRequireMicrosoftAuthenticatedPrincipal.mockResolvedValueOnce({
      accountId: 'owner@punxsyprominence.org',
      role: 'platform_owner',
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'microsoft',
    });

    const response = await POST(makeRequest({ account_id: 'ath-account-3', pin: '123456', mode }));

    expect(response.status).toBe(403);
    expect(mockReset).not.toHaveBeenCalled();
  });
});
