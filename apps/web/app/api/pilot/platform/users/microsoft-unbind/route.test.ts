import { NextRequest } from 'next/server';

import { POST } from './route';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import { unbindMicrosoftIdentity } from '@/src/server/pilot/microsoftIdentityUnbind';

jest.mock('@/src/server/pilot/http', () => ({
  requireMicrosoftAuthenticatedPrincipal: jest.fn(),
  jsonError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Forbidden')) return new Response(JSON.stringify({ error: message }), { status: 403 });
    if (message.startsWith('Missing')) return new Response(JSON.stringify({ error: message }), { status: 400 });
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  },
}));

jest.mock('@/src/server/pilot/microsoftIdentityUnbind', () => ({
  unbindMicrosoftIdentity: jest.fn().mockResolvedValue({ accountId: 'coach-1', cleared: true }),
}));

const mockPrincipal = requireMicrosoftAuthenticatedPrincipal as jest.Mock;
const mockUnbind = unbindMicrosoftIdentity as jest.Mock;

function principal(role: string) {
  return { accountId: 'Admin@example.org', role, organizationId: 'org-1', athleteId: null, sessionToken: 't', authProvider: 'microsoft' };
}

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/pilot/platform/users/microsoft-unbind', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/pilot/platform/users/microsoft-unbind', () => {
  test('refuses a session that is not Microsoft-authenticated', async () => {
    mockPrincipal.mockRejectedValueOnce(new Error('Forbidden: Microsoft-authenticated session required'));
    const response = await POST(makeRequest({ account_id: 'coach-1' }));
    expect(response.status).toBe(403);
    expect(mockUnbind).not.toHaveBeenCalled();
  });

  test.each(['coach', 'organization_admin'])('refuses a %s: this is the platform owner\'s route', async (role) => {
    mockPrincipal.mockResolvedValueOnce(principal(role));
    const response = await POST(makeRequest({ account_id: 'coach-1' }));
    expect(response.status).toBe(403);
    expect(mockUnbind).not.toHaveBeenCalled();
  });

  test('refuses a missing account_id', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('platform_owner'));
    const response = await POST(makeRequest({}));
    expect(response.status).toBe(400);
    expect(mockUnbind).not.toHaveBeenCalled();
  });

  test('passes the session\'s own principal and the trimmed account id', async () => {
    mockPrincipal.mockResolvedValueOnce(principal('platform_owner'));
    const response = await POST(makeRequest({ account_id: ' coach-1 ' }));
    expect(response.status).toBe(200);
    expect(mockUnbind).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'Admin@example.org', role: 'platform_owner' }), 'coach-1');
    await expect(response.json()).resolves.toEqual({ ok: true, account_id: 'coach-1', cleared: true });
  });
});
