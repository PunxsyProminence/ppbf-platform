import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getOrganizationWaiverStatus } from '@/src/server/pilot/waiverCompliance';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/waiverCompliance', () => ({
  getOrganizationWaiverStatus: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockGetStatus = jest.mocked(getOrganizationWaiverStatus);

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
  return GET(new NextRequest('http://localhost/api/pilot/admin/waiver-status'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetStatus.mockResolvedValue([]);
});

test('an admin gets the org-wide waiver status, snake_cased at the boundary', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal());
  mockGetStatus.mockResolvedValueOnce([
    {
      athleteId: 'ath-1',
      athleteName: 'Jordan T.',
      activeFlag: true,
      waivers: { general: 'signed', medical_release: 'missing', photo_media: 'signed', travel: 'missing' },
    },
  ]);

  const response = await get();

  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.items).toEqual([
    {
      athlete_id: 'ath-1',
      athlete_name: 'Jordan T.',
      active_flag: true,
      waivers: { general: 'signed', medical_release: 'missing', photo_media: 'signed', travel: 'missing' },
    },
  ]);
  expect(mockGetStatus).toHaveBeenCalledWith('org-a');
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
    expect(mockGetStatus).not.toHaveBeenCalled();
  },
);
