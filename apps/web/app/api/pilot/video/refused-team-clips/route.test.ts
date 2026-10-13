import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { countRefusedTeamClips } from '@/src/server/pilot/refusedTeamClips';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// The predicate itself is proven on real rows in refusedTeamClips.pg.test.ts.
jest.mock('@/src/server/pilot/refusedTeamClips', () => ({
  countRefusedTeamClips: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockCount = countRefusedTeamClips as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(role: PilotPrincipal['role']): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function request() {
  return new NextRequest('http://localhost/api/pilot/video/refused-team-clips');
}

describe('GET /api/pilot/video/refused-team-clips', () => {
  test.each(['organization_admin', 'admin'] as const)('an organization admin (%s) gets the count for their own organization', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockCount.mockResolvedValue(3);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 3 });
    expect(mockCount).toHaveBeenCalledWith('org-1');
  });

  test.each(['coach', 'athlete', 'parent', 'platform_owner'] as const)('%s is refused and nothing is counted', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mockCount).not.toHaveBeenCalled();
  });
});
