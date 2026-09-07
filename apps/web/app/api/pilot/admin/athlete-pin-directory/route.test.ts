import { NextRequest } from 'next/server';

import { GET } from './route';
import { query } from '@/src/server/pilot/db';
import {
  requireMicrosoftAuthenticatedPrincipal,
  requireMicrosoftOrAttestedLocalPinPrincipal,
} from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  requireMicrosoftAuthenticatedPrincipal: jest.fn(),
  requireMicrosoftOrAttestedLocalPinPrincipal: jest.fn(),
  jsonError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Unauthorized')) return new Response(JSON.stringify({ error: message }), { status: 401 });
    if (message.startsWith('Forbidden')) return new Response(JSON.stringify({ error: message }), { status: 403 });
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  },
}));

// BASE04-D004: this read sits behind the credential gate that admits a
// Microsoft session or a server-attested local PIN session. The existing
// cases model what that gate returned; the Microsoft-only gate is kept only
// to prove the route no longer calls it.
const mockRequirePrincipal = requireMicrosoftOrAttestedLocalPinPrincipal as jest.Mock;
const mockRequireMicrosoft = requireMicrosoftAuthenticatedPrincipal as jest.Mock;
const mockQuery = query as jest.Mock;

function principal(role: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft' as const,
    ...overrides,
  };
}

function attestedLocal(role: string) {
  return principal(role, { authProvider: 'ppbf_local', pinAuthPermitted: true });
}

function request() {
  return new NextRequest('http://localhost/api/pilot/admin/athlete-pin-directory', { method: 'GET' });
}

afterEach(() => {
  jest.clearAllMocks();
});

// This route returns every athlete's full name in an organization alongside
// their account state. access.ts refuses the board and the platform owner every
// athlete-scoped record, and this is the widest athlete-scoped read there is.
describe('GET /api/pilot/admin/athlete-pin-directory', () => {
  test('the gym administrator gets the directory, scoped to their own organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockQuery.mockResolvedValueOnce([
      { athlete_id: 'ath-1', full_name: 'A Real Child', account_id: 'acc-1', account_active: true, has_pin: true, account_updated_at: null },
    ]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-1']);
    expect(mockRequireMicrosoft).not.toHaveBeenCalled();
  });

  test('admits a server-attested local organization admin the Microsoft-only gate would refuse', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(attestedLocal('organization_admin'));
    mockRequireMicrosoft.mockRejectedValueOnce(new Error('Forbidden: Microsoft-authenticated session required'));
    mockQuery.mockResolvedValueOnce([]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    const [, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-1']);
    expect(mockRequirePrincipal).toHaveBeenCalledTimes(1);
    expect(mockRequireMicrosoft).not.toHaveBeenCalled();
  });

  // Credential admission is not authorization. An attested local coach or
  // athlete clears the credential gate and is stopped by the same role gate
  // that stops them today, before a single row is read.
  test.each(['coach', 'athlete'])(
    'an attested local %s passes the credential gate and is refused by the role gate',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(attestedLocal(role));

      const response = await GET(request());
      const payload = await response.json();

      expect(response.status).toBe(403);
      expect(payload.error).toBe('Forbidden: role not allowed');
      expect(mockQuery).not.toHaveBeenCalled();
    },
  );

  test('the platform owner is refused, and no roster is read', async () => {
    // Athlete credentials sit outside the platform-owner tier, the same
    // boundary session revocation and PIN reset hold. A route that hands Omega
    // every child's name contradicts what access.ts enforces everywhere else.
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test.each(['coach', 'athlete', 'parent', 'board', 'staff', 'volunteer'])(
    'refuses %s without reading anything',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));

      const response = await GET(request());

      expect(response.status).toBe(403);
      expect(mockQuery).not.toHaveBeenCalled();
    },
  );

  test('the organization is taken from the session, never from the request', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockQuery.mockResolvedValueOnce([]);

    await GET(new NextRequest(
      'http://localhost/api/pilot/admin/athlete-pin-directory?organization_id=org-someone-else',
      { method: 'GET' },
    ));

    const [sql, params] = mockQuery.mock.calls[0];
    expect(params).toEqual(['org-1']);
    expect(sql).toContain('ath.organization_id = $1');
    expect(sql).not.toContain('$2');
  });
});
