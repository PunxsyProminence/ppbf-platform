import { NextRequest } from 'next/server';

import { GET } from './route';
import { countUnseenFamilyThreadPostsForStaff } from '@/src/server/pilot/familyThreads';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// Who is counted (a coach's athleteIdsForCoach, admins the gym, live athletes, this staff
// member's own reads) is proved on Postgres in familyThreadsStaff.pg.test.ts. Here: the role
// gate, and that the route hands down the session's identity, never the query's. (W4 item 4, PM-2)
jest.mock('@/src/server/pilot/familyThreads', () => ({
  countUnseenFamilyThreadPostsForStaff: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockCount = jest.mocked(countUnseenFamilyThreadPostsForStaff);

function principal(role = 'coach') {
  return {
    accountId: 'staff-1',
    role,
    organizationId: 'org-1',
    athleteId: role === 'athlete' ? 'ath-1' : null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as never;
}

function get(query = '') {
  return GET(new NextRequest(`http://localhost/api/pilot/coach/family-threads/unread${query}`));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/coach/family-threads/unread (W4 item 4)', () => {
  test.each(['coach', 'organization_admin', 'admin'])('%s reads their own count, as themselves', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockCount.mockResolvedValue([{ athlete_id: 'ath-1', unseen: 2 }]);
    const response = await get('?account_id=someone-else&role=admin');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, items: [{ athlete_id: 'ath-1', unseen: 2 }] });
    expect(mockCount).toHaveBeenCalledWith({ organizationId: 'org-1', accountId: 'staff-1', role });
  });

  test.each(['parent', 'athlete', 'board', 'platform_owner', 'volunteer', 'staff'])('%s is refused', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    expect((await get()).status).toBe(403);
    expect(mockCount).not.toHaveBeenCalled();
  });
});
