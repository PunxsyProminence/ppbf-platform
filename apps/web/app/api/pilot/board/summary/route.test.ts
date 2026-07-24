import { NextRequest } from 'next/server';

import { GET } from './route';
import { getBoardSummary } from '@/src/server/pilot/boardSummary';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/boardSummary', () => ({
  getBoardSummary: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockGetBoardSummary = jest.mocked(getBoardSummary);

const summary = {
  scope: 'organization_aggregate' as const,
  minimumCohortSize: 5,
  generatedAt: '2026-07-24T12:00:00.000Z',
  activeAthletes: { status: 'available' as const, count: 10 },
  trainingSessions30Days: {
    status: 'available' as const,
    count: 8,
    completedCount: 6,
    completionRate: 0.75,
  },
  goalStatusBuckets: {
    active: { status: 'available' as const, count: 7 },
    completed: { status: 'unavailable' as const, count: null },
    other: { status: 'insufficient_data' as const, count: null },
  },
  coachReviews30Days: {
    status: 'available' as const,
    count: 6,
    approvedCount: 5,
    approvalRate: 0.8333,
  },
};

beforeEach(() => {
  jest.resetAllMocks();
  mockGetBoardSummary.mockResolvedValue(summary);
});

test('uses only the authenticated Board organization and ignores requested organization values', async () => {
  mockRequirePrincipal.mockResolvedValueOnce({
    accountId: 'board-account',
    role: 'board',
    organizationId: 'org-authenticated',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
  });

  const response = await GET(new NextRequest(
    'http://localhost/api/pilot/board/summary?organizationId=org-other',
  ));

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(mockGetBoardSummary).toHaveBeenCalledWith('org-authenticated');
  const payload = await response.json();
  expect(payload).toEqual({ success: true, summary });
  expect(JSON.stringify(payload)).not.toMatch(
    /board-account|org-authenticated|org-other|athleteId|accountId|notes|message/i,
  );
});

test.each(['coach', 'organization_admin', 'admin', 'athlete'] as const)(
  'denies the %s role from the Board aggregate endpoint',
  async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce({
      accountId: 'other-account',
      role,
      organizationId: 'org-1',
      athleteId: role === 'athlete' ? 'athlete-1' : null,
      sessionToken: 'token',
      authProvider: 'ppbf_local',
    });

    const response = await GET(new NextRequest(
      'http://localhost/api/pilot/board/summary',
    ));

    expect(response.status).toBe(403);
    expect(mockGetBoardSummary).not.toHaveBeenCalled();
  },
);
