import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getOrganizationSafetyReview } from '@/src/server/pilot/safetyReview';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/safetyReview', () => ({
  getOrganizationSafetyReview: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockGetReview = jest.mocked(getOrganizationSafetyReview);

function principal(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-admin',
    role: 'admin' as const,
    organizationId: 'org-a',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft' as const,
    ...overrides,
  };
}

function get(): Promise<Response> {
  return GET(new NextRequest('http://localhost/api/pilot/admin/safety-review'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetReview.mockResolvedValue({ openHolds: [], failingGates: [], openEscalations: [], openViolations: [] });
});

test('an admin gets the rolled-up review, spread at the top level', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockGetReview.mockResolvedValueOnce({
    openHolds: [{ hold_id: 'hold-1' } as never],
    failingGates: [],
    openEscalations: [],
    openViolations: [],
  });

  const response = await get();

  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.ok).toBe(true);
  expect(payload.openHolds).toHaveLength(1);
  expect(mockGetReview).toHaveBeenCalledWith('org-a');
});

test.each(['organization_admin'] as const)('allows the %s role', async (role) => {
  mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));

  const response = await get();

  expect(response.status).toBe(200);
});

test.each(['coach', 'athlete', 'parent', 'board', 'platform_owner', 'volunteer'] as const)(
  'denies the %s role',
  async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role, athleteId: role === 'athlete' ? 'ath-1' : null }));

    const response = await get();

    expect(response.status).toBe(403);
    expect(mockGetReview).not.toHaveBeenCalled();
  },
);
