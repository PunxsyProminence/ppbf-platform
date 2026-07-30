import { NextRequest } from 'next/server';

import { POST } from './route';
import { createAthleteAccount } from '@/src/server/pilot/auth';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/auth', () => ({
  createAthleteAccount: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/http', () => ({
  requireMicrosoftAuthenticatedPrincipal: jest.fn(),
  jsonError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Unauthorized')) return new Response(JSON.stringify({ error: message }), { status: 401 });
    if (message.startsWith('Forbidden')) return new Response(JSON.stringify({ error: message }), { status: 403 });
    if (message.startsWith('Missing')) return new Response(JSON.stringify({ error: message }), { status: 400 });
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  },
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequireMicrosoftAuthenticatedPrincipal = requireMicrosoftAuthenticatedPrincipal as jest.Mock;
const mockCreateAthleteAccount = createAthleteAccount as jest.Mock;

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/admin/athlete-accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/pilot/admin/athlete-accounts', () => {
  test('denies PIN-auth sessions for athlete provisioning', async () => {
    mockRequireMicrosoftAuthenticatedPrincipal.mockRejectedValueOnce(
      new Error('Forbidden: Microsoft-authenticated session required'),
    );

    const response = await POST(makeRequest({ account_id: 'ath-account-1', athlete_id: 'ath-1' }));

    expect(response.status).toBe(403);
    expect(mockCreateAthleteAccount).not.toHaveBeenCalled();
  });

  test('creates a pending athlete account without setting a PIN', async () => {
    mockRequireMicrosoftAuthenticatedPrincipal.mockResolvedValueOnce({
      accountId: 'admin@punxsyprominence.org',
      role: 'organization_admin',
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'microsoft',
    });

    const response = await POST(makeRequest({ account_id: 'ath-account-1', athlete_id: 'ath-1' }));

    expect(response.status).toBe(200);
    expect(mockCreateAthleteAccount).toHaveBeenCalledWith('ath-account-1', 'ath-1', 'org-1');
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      account_id: 'ath-account-1',
      athlete_id: 'ath-1',
      account_state: 'pending_pin_activation',
    });
  });

  test('allows the platform owner to create a pending athlete account in their organization', async () => {
    mockRequireMicrosoftAuthenticatedPrincipal.mockResolvedValueOnce({
      accountId: 'owner@punxsyprominence.org',
      role: 'platform_owner',
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'microsoft',
    });

    const response = await POST(makeRequest({ account_id: 'ath-account-2', athlete_id: 'ath-2' }));

    expect(response.status).toBe(200);
    expect(mockCreateAthleteAccount).toHaveBeenCalledWith('ath-account-2', 'ath-2', 'org-1');
  });
});
