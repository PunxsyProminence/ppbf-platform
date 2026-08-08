import { NextRequest } from 'next/server';

import { GET } from './route';
import { getBoardEscalationSummary } from '@/src/server/pilot/escalationLadder';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/escalationLadder', () => ({
  getBoardEscalationSummary: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockSummary = jest.mocked(getBoardEscalationSummary);

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

describe('GET /api/pilot/board/escalation-summary', () => {
  test('board reads the k-anonymity-gated summary for its own organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('board'));
    mockSummary.mockResolvedValueOnce({
      scope: 'organization_aggregate',
      minimumCohortSize: 5,
      generatedAt: 'now',
      openBySeverity: {
        critical: { status: 'insufficient_data', count: null },
        high: { status: 'unavailable', count: null },
        moderate: { status: 'unavailable', count: null },
        low: { status: 'unavailable', count: null },
      },
    } as never);

    const response = await GET(new NextRequest('http://localhost/api/pilot/board/escalation-summary'));

    expect(response.status).toBe(200);
    expect(mockSummary).toHaveBeenCalledWith('org-a');
    const body = await response.json();
    // The suppressed bucket stays suppressed all the way to the wire: a
    // small cohort must never surface as a small real number.
    expect(body.summary.openBySeverity.critical).toEqual({ status: 'insufficient_data', count: null });
  });

  // This is the board's ONLY escalation surface; every other role has the
  // full /api/pilot/escalations route and must not double-dip here, where
  // the k-anonymity floor is the sole protection layer.
  test.each(['coach', 'organization_admin', 'admin', 'athlete', 'parent'])(
    '%s is refused',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal(role));

      const response = await GET(new NextRequest('http://localhost/api/pilot/board/escalation-summary'));

      expect(response.status).toBe(403);
      expect(mockSummary).not.toHaveBeenCalled();
    },
  );
});
