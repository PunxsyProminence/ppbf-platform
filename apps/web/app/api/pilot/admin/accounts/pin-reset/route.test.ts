import { NextRequest } from 'next/server';

import { POST } from './route';
import { activateAccountPin, resetAccountPin } from '@/src/server/pilot/auth';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/auth', () => ({
  activateAccountPin: jest.fn().mockResolvedValue(undefined),
  resetAccountPin: jest.fn().mockResolvedValue(undefined),
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
const mockActivate = activateAccountPin as jest.Mock;
const mockReset = resetAccountPin as jest.Mock;

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
    expect(mockActivate).not.toHaveBeenCalled();
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
    expect(mockActivate).not.toHaveBeenCalled();
  });

  test('activates PIN only within principal organization scope', async () => {
    mockRequireMicrosoftAuthenticatedPrincipal.mockResolvedValueOnce({
      accountId: 'admin@punxsyprominence.org',
      role: 'organization_admin',
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'microsoft',
    });

    const response = await POST(makeRequest({ account_id: 'ath-account-1', pin: '123456', mode: 'activate' }));

    expect(response.status).toBe(200);
    expect(mockActivate).toHaveBeenCalledWith('ath-account-1', '123456', 'org-1');
    expect(mockReset).not.toHaveBeenCalled();
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
    expect(mockReset).toHaveBeenCalledWith('ath-account-2', '123456', 'org-1');
    expect(mockActivate).not.toHaveBeenCalled();
  });

  test('allows the platform owner to activate an athlete PIN, still organization-scoped', async () => {
    // The platform owner IS this gym's administrator; locking these routes to
    // organization_admin only meant the person running the pilot could not
    // manage athlete PINs at all (re-landed from PR #20, which went stale).
    mockRequireMicrosoftAuthenticatedPrincipal.mockResolvedValueOnce({
      accountId: 'owner@punxsyprominence.org',
      role: 'platform_owner',
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'microsoft',
    });

    const response = await POST(makeRequest({ account_id: 'ath-account-3', pin: '123456', mode: 'activate' }));

    expect(response.status).toBe(200);
    expect(mockActivate).toHaveBeenCalledWith('ath-account-3', '123456', 'org-1');
    expect(mockReset).not.toHaveBeenCalled();
  });
});
