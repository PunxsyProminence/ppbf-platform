import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listResourcesForGuardian } from '@/src/server/pilot/parentResources';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// Which resources a family reads (the guardian link, programs, drafts, other
// gyms, staff pages) is proved on Postgres in parentResourcesRead.pg.test.ts.
// Here: the role, and that the gym and account come from the session.
// (#1593, PH-11)
jest.mock('@/src/server/pilot/parentResources', () => ({
  listResourcesForGuardian: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockList = jest.mocked(listResourcesForGuardian);

function principal(role = 'parent') {
  return { accountId: 'parent-1', role, organizationId: 'org-1', athleteId: null, sessionToken: 'token', authProvider: 'microsoft' } as never;
}

const ITEM = { resource_id: 'r1', title: 'Hydration', summary: 'Drink.', resource_type: 'guide' as const, destination_kind: 'internal' as const, destination: '/help' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/parent/resources (#1593, PH-11)', () => {
  test('a guardian reads one child, with the gym and account from the session', async () => {
    mockPrincipal.mockResolvedValue(principal());
    mockList.mockResolvedValue([ITEM]);

    const response = await GET(new NextRequest('http://localhost/api/pilot/parent/resources?athlete_id=ath-1&organization_id=org-other'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, items: [ITEM] });
    expect(mockList).toHaveBeenCalledWith('org-1', 'parent-1', 'ath-1');
  });

  test('no child is a 400 and reads nothing', async () => {
    mockPrincipal.mockResolvedValue(principal());
    const response = await GET(new NextRequest('http://localhost/api/pilot/parent/resources'));
    expect(response.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  test.each(['athlete', 'coach', 'organization_admin', 'admin', 'board', 'platform_owner'])('%s is refused and nothing is read', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await GET(new NextRequest('http://localhost/api/pilot/parent/resources?athlete_id=ath-1'));
    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
});
