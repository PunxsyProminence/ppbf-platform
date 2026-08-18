import { NextRequest } from 'next/server';

import { GET } from './route';
import { getBoardExternalCompetitionSummary } from '@/src/server/pilot/externalCompetition';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/externalCompetition', () => ({
  getBoardExternalCompetitionSummary: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockSummary = jest.mocked(getBoardExternalCompetitionSummary);

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

describe('GET /api/pilot/board/external-competition-summary', () => {
  test('board reads the k-anonymity-gated summary for its own organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('board'));
    mockSummary.mockResolvedValueOnce({
      scope: 'organization_aggregate',
      minimumCohortSize: 5,
      generatedAt: 'now',
      competitionsByStatus: { planned: 2, completed: 1, cancelled: 0 },
      entriesByResult: {
        won: { status: 'insufficient_data', count: null },
        lost: { status: 'insufficient_data', count: null },
        draw: { status: 'unavailable', count: null },
        no_contest: { status: 'unavailable', count: null },
      },
    } as never);

    const response = await GET(new NextRequest('http://localhost/api/pilot/board/external-competition-summary'));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mockSummary).toHaveBeenCalledWith('org-a');

    const body = await response.json();
    // The suppressed win/loss buckets stay suppressed all the way to the
    // wire: a small cohort must never surface as a small real number.
    expect(body.summary.entriesByResult.won).toEqual({ status: 'insufficient_data', count: null });
    expect(body.summary.entriesByResult.lost).toEqual({ status: 'insufficient_data', count: null });
  });

  // This is the board's ONLY external-competition surface; every other
  // reader uses /api/pilot/operations/external-competition/* and must not
  // double-dip here, where the k-anonymity floor is the sole protection
  // layer.
  test.each(['coach', 'organization_admin', 'admin', 'athlete', 'parent'])(
    '%s is refused',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));

      const response = await GET(new NextRequest('http://localhost/api/pilot/board/external-competition-summary'));

      expect(response.status).toBe(403);
      expect(mockSummary).not.toHaveBeenCalled();
    },
  );
});
