// Handing a gym's admin seat to someone else (lane L31, gap check (b) step 6).
// The route had no tests. Three things are pinned here: it is platform work
// and signs in with Microsoft; the outgoing admin can only become a staff role
// (the legacy 'admin' spelling left two admins, and 'athlete' or 'parent' made
// accounts with no roster record or child); and the audit row names the gym.

import { NextRequest } from 'next/server';

import { POST } from './route';
import { transferOrganizationAdmin } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requireMicrosoftAuthenticatedPrincipal, requirePrincipal } from '@/src/server/pilot/http';

// The plain session read is wired to refuse, so a route that reached for it
// instead of the Microsoft gate fails every case here.
jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requireMicrosoftAuthenticatedPrincipal: jest.fn(),
  requirePrincipal: jest.fn(async () => { throw new Error('Forbidden: the plain session read is not the gate of this route'); }),
}));
jest.mock('@/src/server/pilot/auth', () => ({ transferOrganizationAdmin: jest.fn() }));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

const mockMicrosoft = jest.mocked(requireMicrosoftAuthenticatedPrincipal);
const mockPlainSession = jest.mocked(requirePrincipal);
const mockTransfer = jest.mocked(transferOrganizationAdmin);
const mockAudit = jest.mocked(writePilotAuditEvent);

function as(role: string) {
  mockMicrosoft.mockResolvedValue({ accountId: `${role}-1`, organizationId: '__platform__', role } as never);
}

function post(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/platform/organizations/transfer-admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const BODY = { organization_id: 'gym-b', from_account_id: 'old-admin', to_account_id: 'new-admin' };

beforeEach(() => {
  jest.clearAllMocks();
  as('platform_owner');
  mockTransfer.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined as never);
});

test('the platform owner hands the seat over; the outgoing admin becomes a coach by default; the audit row names the gym', async () => {
  const response = await POST(post(BODY));
  expect(response.status).toBe(200);
  expect(mockTransfer).toHaveBeenCalledWith('old-admin', 'new-admin', 'gym-b', 'coach');
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    organization_id: 'gym-b',
    entity_type: 'organization_membership',
    details: expect.objectContaining({ action: 'transfer_organization_admin', demote_role: 'coach' }),
  }));
});

test.each(['coach', 'staff', 'volunteer'])('the outgoing admin may become %s', async (role) => {
  const response = await POST(post({ ...BODY, demote_role: role }));
  expect(response.status).toBe(200);
  expect(mockTransfer).toHaveBeenCalledWith('old-admin', 'new-admin', 'gym-b', role);
});

test.each(['admin', 'organization_admin', 'athlete', 'parent', 'platform_owner', 'board'])(
  'the outgoing admin may not become %s, and nothing is changed',
  async (role) => {
    const response = await POST(post({ ...BODY, demote_role: role }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Unsupported demote_role');
    expect(mockTransfer).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  },
);

test('a session that did not sign in with Microsoft is refused by the Microsoft gate', async () => {
  mockMicrosoft.mockRejectedValue(new Error('Forbidden: Microsoft-authenticated session required'));
  const response = await POST(post(BODY));
  expect(response.status).toBe(403);
  expect((await response.json()).error).toMatch(/Microsoft-authenticated session required/);
  expect(mockPlainSession).not.toHaveBeenCalled();
  expect(mockTransfer).not.toHaveBeenCalled();
});

test.each(['organization_admin', 'coach'])('a %s is refused', async (role) => {
  as(role);
  const response = await POST(post(BODY));
  expect(response.status).toBe(403);
  expect(mockTransfer).not.toHaveBeenCalled();
});
