// The platform staff list and platform staff provisioning are platform work:
// Admin@ (platform_owner) keeps both. What changes is what the list carries --
// a gym's staff and parents, never its athletes' logins (OD-2026-09-28-005;
// OD-2026-10-08-003 R3, "Hide athlete rows").

import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import {
  createOrUpdateMicrosoftStaffAccount,
  listOrganizationMembers,
} from '@/src/server/pilot/staffProvisioning';

// requireRole and jsonError stay real.
jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requireMicrosoftAuthenticatedPrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/staffProvisioning', () => ({
  ...jest.requireActual('@/src/server/pilot/staffProvisioning'),
  createOrUpdateMicrosoftStaffAccount: jest.fn(),
  listOrganizationMembers: jest.fn(),
}));

const mockPrincipal = jest.mocked(requireMicrosoftAuthenticatedPrincipal);
const mockAudit = jest.mocked(writePilotAuditEvent);
const mockList = jest.mocked(listOrganizationMembers);
const mockProvision = jest.mocked(createOrUpdateMicrosoftStaffAccount);

const URL_BASE = 'http://localhost/api/pilot/platform/staff';

const COACH_ROW = {
  account_id: 'coach-1', login_email: 'coach@example.org', auth_provider: 'microsoft', role: 'coach',
  athlete_id: null, active_flag: true, has_pin: false, membership_active: true,
};
const PARENT_ROW = { ...COACH_ROW, account_id: 'parent-1', login_email: 'parent@example.org', role: 'parent' };

function as(role: string) {
  mockPrincipal.mockResolvedValue({
    accountId: `${role}-1`, organizationId: '__platform__', role, authProvider: 'microsoft',
  } as never);
}

function get(query = '?organization_id=gym-a') {
  return new NextRequest(`${URL_BASE}${query}`);
}

function post(body: Record<string, unknown>) {
  return new NextRequest(URL_BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  as('platform_owner');
  mockList.mockResolvedValue([COACH_ROW, PARENT_ROW] as never);
  mockProvision.mockResolvedValue({
    accountId: 'coach-2', organizationId: 'gym-a', role: 'coach', loginEmail: 'new@example.org', created: true,
  } as never);
  mockAudit.mockResolvedValue(undefined as never);
});

describe('GET platform staff', () => {
  test('asks for the named gym\'s members WITHOUT athlete rows', async () => {
    const response = await GET(get());

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockList).toHaveBeenCalledWith('gym-a', { includeAthletes: false });
  });

  test('the platform owner still receives staff and parents', async () => {
    const response = await GET(get());

    await expect(response.json()).resolves.toEqual({
      ok: true,
      organization_id: 'gym-a',
      members: [COACH_ROW, PARENT_ROW],
    });
  });

  test('a missing organization_id is a 400 and reads nothing', async () => {
    const response = await GET(get(''));

    expect(response.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  // Unchanged by this lane: the list is the platform owner's only.
  test.each(['organization_admin', 'admin', 'coach', 'athlete'])('role %s is refused', async (role) => {
    as(role);

    const response = await GET(get());

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('POST platform staff provisioning still works for the platform owner', () => {
  test('provisions a coach in the named gym and audits it there', async () => {
    const response = await POST(post({
      organization_id: 'gym-a', login_email: 'new@example.org', role: 'coach',
    }));

    expect(response.status).toBe(200);
    expect(mockProvision).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'gym-a', loginEmail: 'new@example.org', role: 'coach',
    }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      actor_role: 'platform_owner',
      organization_id: 'gym-a',
      entity_type: 'account',
      details: expect.objectContaining({ action: 'platform_owner_provision_staff' }),
    }));
  });

  test('an organization admin cannot use the platform route', async () => {
    as('organization_admin');

    const response = await POST(post({
      organization_id: 'gym-a', login_email: 'new@example.org', role: 'coach',
    }));

    expect(response.status).toBe(403);
    expect(mockProvision).not.toHaveBeenCalled();
  });
});
