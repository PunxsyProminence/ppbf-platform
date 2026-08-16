import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getCommunityServiceTotals } from '@/src/server/pilot/communityService';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/communityService', () => ({ getCommunityServiceTotals: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockTotals = getCommunityServiceTotals as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'admin',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = (query = '') =>
  new NextRequest(`http://localhost/api/pilot/admin/community-service?${query}`);

test('athletes and parents have no path to other people service records', async () => {
  for (const role of ['athlete', 'parent', 'platform_owner'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockTotals).not.toHaveBeenCalled();
});

test('the read is org-scoped from the principal and passes through the window filters', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockTotals.mockResolvedValue([]);

  const response = await GET(getRequest('since=2026-01-01&until=2026-08-16'));
  expect(response.status).toBe(200);
  expect(mockTotals).toHaveBeenCalledWith('org-1', expect.objectContaining({
    since: '2026-01-01', until: '2026-08-16',
  }));
});
