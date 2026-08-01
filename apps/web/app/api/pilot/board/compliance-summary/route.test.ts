import { NextRequest } from 'next/server';

import { GET } from './route';
import { getOrganizationViolationSummary } from '@/src/server/pilot/compliance';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/compliance', () => ({
  getOrganizationViolationSummary: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockGetSummary = jest.mocked(getOrganizationViolationSummary);

const suppressed = { status: 'insufficient_data' as const, count: null };
const summary = {
  audience: 'board' as const,
  minimumCohortSize: 5,
  generatedAt: '2026-07-24T12:00:00.000Z',
  total: { status: 'available' as const, count: 14 },
  severity: { critical: suppressed, high: { status: 'available' as const, count: 13 }, medium: suppressed, low: suppressed },
  status: {
    new: suppressed,
    acknowledged: suppressed,
    escalated: suppressed,
    resolved: suppressed,
    dismissed: suppressed,
  },
};

function boardPrincipal() {
  return {
    accountId: 'board-account',
    role: 'board' as const,
    organizationId: 'org-authenticated',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local' as const,
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockGetSummary.mockResolvedValue(summary);
});

test('reads the authenticated organization under the board aggregate floor', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(boardPrincipal());

  const response = await GET(new NextRequest(
    'http://localhost/api/pilot/board/compliance-summary?organizationId=org-other',
  ));

  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(mockGetSummary).toHaveBeenCalledWith('org-authenticated', {
    audience: 'board',
    status: undefined,
  });

  const payload = await response.json();
  expect(payload).toEqual({ ok: true, summary, statusFilter: 'all' });
  expect(JSON.stringify(payload)).not.toMatch(
    /board-account|org-authenticated|org-other|athlete_id|athleteId|accountId|entity_id|payload/i,
  );
});

test('passes a valid status filter through as a bound value', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(boardPrincipal());

  const response = await GET(new NextRequest(
    'http://localhost/api/pilot/board/compliance-summary?status=escalated',
  ));

  expect(response.status).toBe(200);
  expect(mockGetSummary).toHaveBeenCalledWith('org-authenticated', {
    audience: 'board',
    status: 'escalated',
  });
});

test('rejects a status outside the vocabulary before querying', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(boardPrincipal());

  const response = await GET(new NextRequest(
    "http://localhost/api/pilot/board/compliance-summary?status=new';drop",
  ));

  expect(response.status).toBe(400);
  expect(mockGetSummary).not.toHaveBeenCalled();
});

test.each(['coach', 'organization_admin', 'admin', 'athlete', 'parent'] as const)(
  'denies the %s role',
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
      'http://localhost/api/pilot/board/compliance-summary',
    ));

    expect(response.status).toBe(403);
    expect(mockGetSummary).not.toHaveBeenCalled();
  },
);
