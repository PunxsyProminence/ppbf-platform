import { NextRequest } from 'next/server';

import { GET } from './route';
import { NotFoundError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getSupportStatusForGuardian } from '@/src/server/pilot/parentSupportStatus';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// The guardian-link, projection and ordering rules live in
// parentSupportStatus.ts and are proved on Postgres in
// parentSupportStatus.pg.test.ts. Here: roles, the query, and that the route
// hands down the session's own gym and account, never the request's. (PH-13)
jest.mock('@/src/server/pilot/parentSupportStatus', () => ({
  getSupportStatusForGuardian: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockGet = jest.mocked(getSupportStatusForGuardian);

function principal(role = 'parent') {
  return {
    accountId: 'parent-1',
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as never;
}

function get(query: string) {
  return GET(new NextRequest(`http://localhost/api/pilot/parent/support-status${query}`));
}

const STATUS = {
  memberships: [{ program_name: 'Youth Boxing', status: 'active' as const, started_on: '2025-09-01', ended_on: null }],
  scholarship: 'yes' as const,
  supports: [{ support_kind: 'Gloves and wraps', provided_on: '2025-03-01' }],
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/parent/support-status (PH-13)', () => {
  test("the child's standing is read as this guardian, in this gym", async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGet.mockResolvedValue(STATUS);

    const response = await get('?athlete_id=%20ath-1%20&organization_id=org-2&account_id=someone-else');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, ...STATUS });
    expect(mockGet).toHaveBeenCalledWith('org-1', 'parent-1', 'ath-1');
  });

  test.each(['coach', 'organization_admin', 'admin', 'athlete', 'platform_owner'])('%s is refused', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    const response = await get('?athlete_id=ath-1');

    expect(response.status).toBe(403);
    expect(mockGet).not.toHaveBeenCalled();
  });

  test.each([['no athlete_id', ''], ['a blank athlete_id', '?athlete_id=%20%20']])('%s is a 400', async (_label, query) => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await get(query);

    expect(response.status).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });

  test("a child who is not this guardian's is a 404 with the module's sentence", async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGet.mockRejectedValue(new NotFoundError('Not found: that child is not on your page.'));

    const response = await get('?athlete_id=ath-x');

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Not found: that child is not on your page.');
  });
});
