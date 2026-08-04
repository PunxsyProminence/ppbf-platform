import { NextRequest } from 'next/server';

import { GET } from './route';
import { getCoachPassbookGapQueue } from '@/src/server/pilot/passbook';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/passbook', () => ({
  getCoachPassbookGapQueue: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetGapQueue = getCoachPassbookGapQueue as jest.Mock;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  };
}

const request = new NextRequest('http://localhost/api/pilot/passbook/gaps');

afterEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/passbook/gaps', () => {
  test('scopes a coach to their own assigned athletes', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockGetGapQueue.mockResolvedValueOnce([{ gap_id: 'gap-1' }]);

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mockGetGapQueue).toHaveBeenCalledWith('org-1', 'coach-1');
    await expect(response.json()).resolves.toEqual({ items: [{ gap_id: 'gap-1' }] });
  });

  test.each(['organization_admin', 'admin'] as const)('%s can read the organization queue', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role, accountId: `${role}-1` }));
    mockGetGapQueue.mockResolvedValueOnce([]);

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mockGetGapQueue).toHaveBeenCalledWith('org-1', null);
  });

  test.each(['athlete', 'parent', 'board', 'platform_owner'] as const)('rejects %s', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));

    const response = await GET(request);

    expect(response.status).toBe(403);
    expect(mockGetGapQueue).not.toHaveBeenCalled();
  });
});
