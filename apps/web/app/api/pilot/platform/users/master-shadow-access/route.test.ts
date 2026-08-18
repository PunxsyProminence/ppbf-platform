import { NextRequest } from 'next/server';

import { POST } from './route';
import { setAccountMasterShadowAccess } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/auth', () => ({
  setAccountMasterShadowAccess: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockSetAccess = jest.mocked(setAccountMasterShadowAccess);
const mockAudit = jest.mocked(writePilotAuditEvent);

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
  return POST(new NextRequest('http://localhost/api/pilot/platform/users/master-shadow-access', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  jest.resetAllMocks();
  mockRequirePrincipal.mockResolvedValue(owner());
  mockSetAccess.mockResolvedValue({
    accountId: 'staff-1',
    role: 'staff',
    organizationId: 'org-1',
    hasMasterShadowAccess: true,
  });
});

test('platform owner grants the flag and the grant is audited', async () => {
  const response = await post({ account_id: 'staff-1', granted: true });
  const json = await response.json();

  expect(response.status).toBe(200);
  expect(json).toMatchObject({ ok: true, account_id: 'staff-1', has_master_shadow_access: true });
  expect(mockSetAccess).toHaveBeenCalledWith('staff-1', true);

  expect(mockAudit).toHaveBeenCalledWith(
    expect.objectContaining({
      event_type: 'update',
      actor_account_id: 'platform-owner',
      entity_type: 'account',
      entity_id: 'staff-1',
      details: expect.objectContaining({ action: 'grant_master_shadow_access', has_master_shadow_access: true }),
    }),
  );
});

test('platform owner revokes the flag and the revoke is audited', async () => {
  mockSetAccess.mockResolvedValue({
    accountId: 'staff-1',
    role: 'staff',
    organizationId: 'org-1',
    hasMasterShadowAccess: false,
  });

  const response = await post({ account_id: 'staff-1', granted: false });
  const json = await response.json();

  expect(response.status).toBe(200);
  expect(json.has_master_shadow_access).toBe(false);
  expect(mockSetAccess).toHaveBeenCalledWith('staff-1', false);
  expect(mockAudit).toHaveBeenCalledWith(
    expect.objectContaining({
      details: expect.objectContaining({ action: 'revoke_master_shadow_access', has_master_shadow_access: false }),
    }),
  );
});

test('refuses a caller who is not the platform owner', async () => {
  mockRequirePrincipal.mockResolvedValue({
    ...owner(),
    accountId: 'admin-1',
    role: 'organization_admin',
    organizationId: 'org-1',
  } as PilotPrincipal);

  const response = await post({ account_id: 'staff-1', granted: true });

  expect(response.status).toBe(403);
  expect(mockSetAccess).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

test('requires account_id and an explicit boolean granted', async () => {
  const response = await post({ account_id: 'staff-1' });

  expect(response.status).toBe(400);
  expect(mockSetAccess).not.toHaveBeenCalled();
});

test('propagates a not-found rejection (e.g. an athlete/parent target) as a client error', async () => {
  mockSetAccess.mockRejectedValueOnce(
    new Error('Not found: no such account, or its role cannot hold cross-organization access'),
  );

  const response = await post({ account_id: 'athlete-1', granted: true });

  expect(response.status).toBe(404);
  expect(mockAudit).not.toHaveBeenCalled();
});
