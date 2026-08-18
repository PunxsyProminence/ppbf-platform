import { NextRequest } from 'next/server';

import { GET } from './route';
import { getBoardVolunteerSummary } from '@/src/server/pilot/volunteers';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/volunteers', () => ({
  getBoardVolunteerSummary: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockSummary = jest.mocked(getBoardVolunteerSummary);

function principal(role: string) {
  return {
    accountId: 'acct-caller',
    role,
    organizationId: 'org-a',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as never;
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/board/volunteer-summary', () => {
  test('board reads the k-anonymity-gated summary for its own organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('board'));
    mockSummary.mockResolvedValueOnce({
      scope: 'organization_aggregate',
      minimumCohortSize: 5,
      generatedAt: 'now',
      volunteersByStatus: {
        active: { status: 'insufficient_data', count: null },
        pending: { status: 'unavailable', count: null },
        inactive: { status: 'unavailable', count: null },
      },
      newVolunteers30Days: { status: 'unavailable', count: null },
    } as never);

    const response = await GET(new NextRequest('http://localhost/api/pilot/board/volunteer-summary'));

    expect(response.status).toBe(200);
    expect(mockSummary).toHaveBeenCalledWith('org-a');
    const body = await response.json();
    // The suppressed bucket stays suppressed all the way to the wire: a
    // small cohort must never surface as a small real number.
    expect(body.summary.volunteersByStatus.active).toEqual({ status: 'insufficient_data', count: null });
    // No individual-volunteer-identifying field reaches the response body.
    expect(JSON.stringify(body)).not.toMatch(
      /accountId|account_id|volunteerId|volunteer_id|full_name|fullName|notes|certification|background_check|roleFocus|role_focus/i,
    );
  });

  // This is the board's ONLY volunteer-roster surface; every other role that
  // can see volunteers uses /api/admin/volunteers, and must not double-dip
  // here, where the k-anonymity floor is the sole protection layer.
  test.each(['coach', 'organization_admin', 'admin', 'athlete', 'parent', 'volunteer', 'staff'])(
    '%s is refused',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));

      const response = await GET(new NextRequest('http://localhost/api/pilot/board/volunteer-summary'));

      expect(response.status).toBe(403);
      expect(mockSummary).not.toHaveBeenCalled();
    },
  );

  test('platform_owner is refused -- this route is board-only, unlike board/summary', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await GET(new NextRequest('http://localhost/api/pilot/board/volunteer-summary'));

    expect(response.status).toBe(403);
    expect(mockSummary).not.toHaveBeenCalled();
  });
});
