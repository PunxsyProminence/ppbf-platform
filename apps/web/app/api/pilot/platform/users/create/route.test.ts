import { NextRequest } from 'next/server';

import { POST } from './route';
import { createOrRotateAdminAccount } from '@/src/server/pilot/auth';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/auth', () => ({
  createCoachAccount: jest.fn(),
  createOrRotateAdminAccount: jest.fn(),
  createOrUpdateAthleteAccount: jest.fn(),
  createParentAccount: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockCreateAccount = jest.mocked(createOrRotateAdminAccount);

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
  mockCreateAccount.mockResolvedValue(undefined);
});

test('allows the platform-authorized account path to create a Board account', async () => {
  const response = await POST(new NextRequest(
    'http://localhost/api/pilot/platform/users/create',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organization_id: 'org-1',
        account_id: 'board-account',
        role: 'board',
        pin: '123456',
      }),
    },
  ));

  expect(response.status).toBe(200);
  expect(mockCreateAccount).toHaveBeenCalledWith(
    'board-account',
    '123456',
    'org-1',
    'board',
  );
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    role: 'board',
    athlete_id: null,
  });
});
