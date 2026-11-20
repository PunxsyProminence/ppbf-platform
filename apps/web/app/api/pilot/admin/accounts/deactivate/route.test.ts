import { NextRequest } from 'next/server';

import { DEACTIVATABLE_ROLES, POST } from './route';
import { getAccountRoleInOrganization, setAccountActiveStatus } from '@/src/server/pilot/auth';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { ConflictError } from '@/src/server/pilot/errors';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requireMicrosoftAuthenticatedPrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/auth', () => ({
  getAccountRoleInOrganization: jest.fn(),
  setAccountActiveStatus: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockGate = jest.mocked(requireMicrosoftAuthenticatedPrincipal);
const mockGetRole = jest.mocked(getAccountRoleInOrganization);
const mockSetStatus = jest.mocked(setAccountActiveStatus);
const mockAudit = jest.mocked(writePilotAuditEvent);

function admin(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-admin',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    signInMethod: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function post(body: unknown) {
  return POST(new NextRequest('http://localhost/api/pilot/admin/accounts/deactivate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

beforeEach(() => {
  jest.resetAllMocks();
  mockGate.mockResolvedValue(admin());
  mockGetRole.mockResolvedValue('coach');
  mockSetStatus.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined as never);
});

/* ---- The rulings' shape: coach, staff, volunteer, athlete, and nothing else ---- */

test('the deactivatable roles are exactly coach, staff, volunteer (OD-2026-10-07-009) and athlete (OD-2026-11-19-025)', () => {
  expect([...DEACTIVATABLE_ROLES].sort()).toEqual(['athlete', 'coach', 'staff', 'volunteer']);
});

test.each(['coach', 'staff', 'volunteer', 'athlete'] as const)('deactivates a %s in the caller organization, revoking sessions through setAccountActiveStatus', async (role) => {
  mockGetRole.mockResolvedValue(role);

  const response = await post({ account_id: 'acct-target', active_flag: false });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true, account_id: 'acct-target', active_flag: false, role });
  // The role is read in the CALLER's organization, never one from the body.
  expect(mockGetRole).toHaveBeenCalledWith('acct-target', 'org-1');
  expect(mockSetStatus).toHaveBeenCalledWith('acct-target', 'org-1', false);
});

test('reactivates through the same route with active_flag true', async () => {
  const response = await post({ account_id: 'acct-target', active_flag: true });

  expect(response.status).toBe(200);
  expect(mockSetStatus).toHaveBeenCalledWith('acct-target', 'org-1', true);
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    details: expect.objectContaining({ action: 'organization_admin_reactivate_account', active_flag: true, target_role: 'coach' }),
  }));
});

/* ---- Every refusal, one test each, nothing written ---- */

test.each([
  ['organization_admin', 'a peer admin'],
  ['admin', 'a peer admin under the legacy role name'],
  ['platform_owner', 'the platform owner'],
  ['parent', 'a guardian'],
  ['board', 'a board seat'],
] as const)('refuses to deactivate %s (%s) and writes nothing', async (role, _why) => {
  mockGetRole.mockResolvedValue(role);

  const response = await post({ account_id: 'acct-target', active_flag: false });

  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({
    error: expect.stringContaining(`this account is ${role}`),
  });
  expect(mockSetStatus).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

test('refuses to reactivate a refused role too -- the gate is the same in both directions', async () => {
  mockGetRole.mockResolvedValue('organization_admin');

  const response = await post({ account_id: 'acct-target', active_flag: true });

  expect(response.status).toBe(403);
  expect(mockSetStatus).not.toHaveBeenCalled();
});

test('refuses the caller acting on their own account, before any role is read', async () => {
  const response = await post({ account_id: 'acct-admin', active_flag: false });

  expect(response.status).toBe(403);
  expect(mockGetRole).not.toHaveBeenCalled();
  expect(mockSetStatus).not.toHaveBeenCalled();
});

test('an account unknown in the caller organization (another gym, or nobody) is not found and nothing is written', async () => {
  mockGetRole.mockResolvedValue(null);

  const response = await post({ account_id: 'acct-elsewhere', active_flag: false });

  expect(response.status).toBe(404);
  expect(mockSetStatus).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

/* ---- Who may call ---- */

test.each(['coach', 'staff', 'volunteer', 'parent', 'athlete', 'board', 'platform_owner'] as const)('a %s caller is refused', async (role) => {
  mockGate.mockResolvedValue(admin({ role }));

  const response = await post({ account_id: 'acct-target', active_flag: false });

  expect(response.status).toBe(403);
  expect(mockGetRole).not.toHaveBeenCalled();
  expect(mockSetStatus).not.toHaveBeenCalled();
});

test('the legacy admin role name may call, as everywhere else', async () => {
  mockGate.mockResolvedValue(admin({ role: 'admin' }));

  const response = await post({ account_id: 'acct-target', active_flag: false });

  expect(response.status).toBe(200);
});

test('a session that is not Microsoft-authenticated is refused by the gate', async () => {
  mockGate.mockRejectedValue(new Error('Forbidden: Microsoft-authenticated session required'));

  const response = await post({ account_id: 'acct-target', active_flag: false });

  expect(response.status).toBe(403);
  expect(mockSetStatus).not.toHaveBeenCalled();
});

/* ---- The body ---- */

test.each([
  ['no account_id', { active_flag: false }],
  ['blank account_id', { account_id: '   ', active_flag: false }],
  ['no active_flag', { account_id: 'acct-target' }],
  ['active_flag as the string "false"', { account_id: 'acct-target', active_flag: 'false' }],
  ['active_flag null', { account_id: 'acct-target', active_flag: null }],
  ['not JSON', '{nope'],
])('%s is a 400 and nothing is written', async (_name, body) => {
  const response = await post(body);

  expect(response.status).toBe(400);
  expect(mockSetStatus).not.toHaveBeenCalled();
});

/* ---- The audit row ---- */

test('a deactivation is audited with the actor, the target and the role that was switched off', async () => {
  mockGetRole.mockResolvedValue('volunteer');

  await post({ account_id: '  acct-target ', active_flag: false });

  expect(mockAudit).toHaveBeenCalledWith({
    event_type: 'update',
    actor_account_id: 'acct-admin',
    actor_role: 'organization_admin',
    organization_id: 'org-1',
    entity_type: 'account',
    entity_id: 'acct-target',
    details: { action: 'organization_admin_deactivate_account', active_flag: false, target_role: 'volunteer' },
  });
});

test('an athlete is reactivated through the same route, the switch the staff rows use (OD-2026-11-19-025)', async () => {
  mockGetRole.mockResolvedValue('athlete');

  const response = await post({ account_id: 'acct-athlete', active_flag: true });

  expect(response.status).toBe(200);
  expect(mockSetStatus).toHaveBeenCalledWith('acct-athlete', 'org-1', true);
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    details: { action: 'organization_admin_reactivate_account', active_flag: true, target_role: 'athlete' },
  }));
});

test.each([false, true])('an athlete with no PIN yet is refused by name (active_flag %s), and not audited as done', async (activeFlag) => {
  mockGetRole.mockResolvedValue('athlete');
  mockSetStatus.mockRejectedValue(new ConflictError(
    'This athlete has not activated their sign-in yet, so there is nothing to switch off.',
    'ATHLETE_SIGN_IN_NOT_ACTIVATED',
  ));

  const response = await post({ account_id: 'acct-athlete', active_flag: activeFlag });

  expect(response.status).toBe(409);
  await expect(response.json()).resolves.toEqual({
    error: 'This athlete has not activated their sign-in yet, so there is nothing to switch off.',
    code: 'ATHLETE_SIGN_IN_NOT_ACTIVATED',
  });
  expect(mockAudit).not.toHaveBeenCalled();
});

test('a refusal from setAccountActiveStatus (a deleted login) surfaces and is not audited as done', async () => {
  mockSetStatus.mockRejectedValue(new Error('Forbidden: this login was deleted'));

  const response = await post({ account_id: 'acct-target', active_flag: false });

  expect(response.status).toBe(403);
  expect(mockAudit).not.toHaveBeenCalled();
});
