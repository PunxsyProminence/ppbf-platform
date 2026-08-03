import { NextRequest } from 'next/server';

import { POST } from './route';
import { getAccountRoleInOrganization, setAccountActiveStatus } from '@/src/server/pilot/auth';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/auth', () => ({
  getAccountRoleInOrganization: jest.fn(),
  setAccountActiveStatus: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockGetRole = jest.mocked(getAccountRoleInOrganization);
const mockSetStatus = jest.mocked(setAccountActiveStatus);

function owner(): PilotPrincipal {
  return {
    accountId: 'platform-owner',
    role: 'platform_owner',
    organizationId: 'platform',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as PilotPrincipal;
}

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/pilot/platform/users/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  jest.resetAllMocks();
  mockRequirePrincipal.mockResolvedValue(owner());
  mockGetRole.mockResolvedValue('coach');
  mockSetStatus.mockResolvedValue(undefined);
});

// setAccountActiveStatus revokes every session for the account it touches.
// Session revocation for a child belongs to that child's own gym -- the same
// boundary the PIN directory, PIN reset and revoke routes hold. This route
// reached any account in any gym, athletes included.
test('refuses to deactivate an athlete account', async () => {
  mockGetRole.mockResolvedValue('athlete');

  const response = await post({
    organization_id: 'org-1',
    account_id: 'ath-001',
    active_flag: false,
  });

  expect(response.status).toBe(403);
  expect(mockSetStatus).not.toHaveBeenCalled();
});

// Reactivation is refused for the same reason: it is the gym's decision either
// way, and allowing only one direction would let the platform tier park a
// child's account in a state their own admin did not choose.
test('refuses to reactivate an athlete account', async () => {
  mockGetRole.mockResolvedValue('athlete');

  const response = await post({
    organization_id: 'org-1',
    account_id: 'ath-001',
    active_flag: true,
  });

  expect(response.status).toBe(403);
  expect(mockSetStatus).not.toHaveBeenCalled();
});

// The capability itself is legitimate and stays: a compromised staff account
// has to be stoppable from outside the gym that holds it.
test('still suspends a staff account in any gym', async () => {
  mockGetRole.mockResolvedValue('coach');

  const response = await post({
    organization_id: 'org-1',
    account_id: 'coach-1',
    active_flag: false,
  });

  expect(response.status).toBe(200);
  expect(mockSetStatus).toHaveBeenCalledWith('coach-1', 'org-1', false);
});

test('refuses a caller who is not the platform owner', async () => {
  mockRequirePrincipal.mockResolvedValue({
    ...owner(),
    accountId: 'admin-1',
    role: 'organization_admin',
    organizationId: 'org-1',
  } as PilotPrincipal);

  const response = await post({
    organization_id: 'org-1',
    account_id: 'coach-1',
    active_flag: false,
  });

  expect(response.status).toBe(403);
  expect(mockSetStatus).not.toHaveBeenCalled();
});

test('requires account_id, organization_id and an explicit active_flag', async () => {
  const response = await post({ organization_id: 'org-1', account_id: 'coach-1' });

  expect(response.status).toBe(400);
  expect(mockSetStatus).not.toHaveBeenCalled();
});
