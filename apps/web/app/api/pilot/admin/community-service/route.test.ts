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

test('the read is scoped from the principal and passes through the window filters', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockTotals.mockResolvedValue([]);

  const response = await GET(getRequest('since=2026-01-01&until=2026-08-16'));
  expect(response.status).toBe(200);
  expect(mockTotals).toHaveBeenCalledWith(
    expect.objectContaining({ organizationId: 'org-1', role: 'admin', accountId: 'acct-1' }),
    expect.objectContaining({ since: '2026-01-01', until: '2026-08-16' }),
  );
});

// Route survey 2026-10-07 (B1): the route handed the service module only the
// organization id, so a coach's read was the whole gym. The WHOLE principal
// (role + account) must reach the service so the coach-reach filter can run
// at the server; a coach-shaped call with only the org id is the bug.
test('a coach read carries the coach identity to the service, not just the organization', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach', accountId: 'acct-coach' }));
  mockTotals.mockResolvedValue([]);

  const response = await GET(getRequest());
  expect(response.status).toBe(200);
  expect(mockTotals).toHaveBeenCalledTimes(1);
  const [actor] = mockTotals.mock.calls[0];
  expect(actor).toEqual(expect.objectContaining({ role: 'coach', accountId: 'acct-coach', organizationId: 'org-1' }));
  expect(typeof actor).not.toBe('string');
});
