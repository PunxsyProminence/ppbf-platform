import { NextRequest } from 'next/server';

import { POST } from './route';
import { upsertOrganizationMembership } from '@/src/server/pilot/auth';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/auth', () => ({
  upsertOrganizationMembership: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockUpsertMembership = jest.mocked(upsertOrganizationMembership);

beforeEach(() => {
  jest.resetAllMocks();
  mockRequirePrincipal.mockResolvedValue({
    accountId: 'platform-owner',
    role: 'platform_owner',
    organizationId: 'platform',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
  });
  mockUpsertMembership.mockResolvedValue(undefined);
});

test('allows the platform-authorized membership path to assign Board', async () => {
  const response = await POST(new NextRequest(
    'http://localhost/api/pilot/platform/organizations/memberships',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organization_id: 'org-1',
        account_id: 'board-account',
        role: 'board',
        active_flag: true,
      }),
    },
  ));

  expect(response.status).toBe(200);
  expect(mockUpsertMembership).toHaveBeenCalledWith(
    'board-account',
    'org-1',
    'board',
    true,
  );
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    role: 'board',
    active_flag: true,
  });
});
