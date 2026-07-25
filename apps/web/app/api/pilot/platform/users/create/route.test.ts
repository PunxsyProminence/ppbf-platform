import { NextRequest } from 'next/server';

import { POST } from './route';
import { createOrUpdateAthleteAccount } from '@/src/server/pilot/auth';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/auth', () => ({
  createOrUpdateAthleteAccount: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockCreateAthleteAccount = jest.mocked(createOrUpdateAthleteAccount);

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
  mockCreateAthleteAccount.mockResolvedValue(undefined);
});

test('creates athlete account in pending activation state without requiring PIN', async () => {
  const response = await POST(new NextRequest(
    'http://localhost/api/pilot/platform/users/create',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organization_id: 'org-1',
        account_id: 'athlete-account',
        role: 'athlete',
        athlete_id: 'ath-1',
      }),
    },
  ));

  expect(response.status).toBe(200);
  expect(mockCreateAthleteAccount).toHaveBeenCalledWith('athlete-account', 'ath-1', 'org-1');
  await expect(response.json()).resolves.toMatchObject({
    ok: true,
    role: 'athlete',
    athlete_id: 'ath-1',
    account_state: 'pending_pin_activation',
  });
});

test('rejects outdated privileged local-PIN role creation paths', async () => {
  const response = await POST(new NextRequest(
    'http://localhost/api/pilot/platform/users/create',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        organization_id: 'org-1',
        account_id: 'coach-account',
        role: 'coach',
      }),
    },
  ));

  expect(response.status).toBe(400);
  expect(mockCreateAthleteAccount).not.toHaveBeenCalled();
  await expect(response.json()).resolves.toMatchObject({
    error: 'Unsupported role: privileged accounts must be Microsoft-authenticated',
  });
});
