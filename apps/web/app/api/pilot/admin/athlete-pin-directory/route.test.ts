import { NextRequest } from 'next/server';

import { GET } from './route';
import { query } from '@/src/server/pilot/db';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  requireMicrosoftAuthenticatedPrincipal: jest.fn(),
  jsonError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('Unauthorized')) return new Response(JSON.stringify({ error: message }), { status: 401 });
    if (message.startsWith('Forbidden')) return new Response(JSON.stringify({ error: message }), { status: 403 });
    return new Response(JSON.stringify({ error: message }), { status: 500 });
  },
}));

const mockRequirePrincipal = requireMicrosoftAuthenticatedPrincipal as jest.Mock;
const mockQuery = query as jest.Mock;

function principal(role: string) {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft' as const,
  };
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
  });

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
