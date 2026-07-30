import { NextRequest } from 'next/server';

import { POST } from './route';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import { revokeAllSessionsForAccountInOrganization } from '@/src/server/pilot/auth';

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

jest.mock('@/src/server/pilot/auth', () => ({
  revokeAllSessionsForAccountInOrganization: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequireMicrosoftAuthenticatedPrincipal = requireMicrosoftAuthenticatedPrincipal as jest.Mock;
const mockRevoke = revokeAllSessionsForAccountInOrganization as jest.Mock;

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/admin/accounts/revoke', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/pilot/admin/accounts/revoke', () => {
  test('denies PIN-auth sessions for privileged revoke action', async () => {
    mockRequireMicrosoftAuthenticatedPrincipal.mockRejectedValueOnce(new Error('Forbidden: Microsoft-authenticated session required'));

    const response = await POST(makeRequest({ account_id: 'ath-1' }));
    expect(response.status).toBe(403);
    expect(mockRevoke).not.toHaveBeenCalled();
  });

  test('allows Microsoft-authenticated org-admin revocation in same organization scope', async () => {
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
    expect(mockRevoke).toHaveBeenCalledWith('ath-account-1', 'org-1');
  });
});
