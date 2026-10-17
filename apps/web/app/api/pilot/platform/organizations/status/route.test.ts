// Setting a gym's status is platform work and stays with the platform owner.
// What this file pins is the audit row: it is filed under the gym whose status
// changed, not under the platform owner's own organization, so it appears in
// that gym's log (the defect #1406 fixed in assign-admin).

import { NextRequest } from 'next/server';

import { POST } from './route';
import { setOrganizationStatus } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotDefaultOrganizationId } from '@/src/server/pilot/env';
import { requirePrincipal } from '@/src/server/pilot/http';
import { PLATFORM_LIBRARY_ORGANIZATION_ID } from '@/src/server/pilot/platformLibraryScope';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/auth', () => ({ setOrganizationStatus: jest.fn() }));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockSetStatus = jest.mocked(setOrganizationStatus);
const mockAudit = jest.mocked(writePilotAuditEvent);

function as(role: string) {
  mockPrincipal.mockResolvedValue({
    accountId: `${role}-1`,
    organizationId: role === 'platform_owner' ? 'platform' : 'org-a',
    role,
  } as never);
}

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/pilot/platform/organizations/status', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  jest.resetAllMocks();
  as('platform_owner');
  mockSetStatus.mockResolvedValue(undefined);
  mockAudit.mockResolvedValue(undefined);
});

test('the platform owner sets a gym\'s status, and the audit row is filed under that gym', async () => {
  const response = await post({ organization_id: '  gym-1  ', status: 'suspended' });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ ok: true, organization_id: 'gym-1', status: 'suspended' });
  expect(mockSetStatus).toHaveBeenCalledWith('gym-1', 'suspended');
  expect(mockAudit).toHaveBeenCalledTimes(1);
  expect(mockAudit.mock.calls[0][0]).toEqual({
    event_type: 'update',
    actor_account_id: 'platform_owner-1',
    actor_role: 'platform_owner',
    organization_id: 'gym-1',
    entity_type: 'organization',
    entity_id: 'gym-1',
    details: { status: 'suspended' },
  });
});

test('a status change that matched no gym writes no audit row', async () => {
  mockSetStatus.mockRejectedValue(new Error('Not found: no such organization'));

  const response = await post({ organization_id: 'no-such-gym', status: 'inactive' });

  expect(response.status).toBe(404);
  expect(mockAudit).not.toHaveBeenCalled();
});

test.each(['organization_admin', 'admin', 'coach', 'athlete', 'parent', 'board', 'staff', 'volunteer'])(
  '%s cannot set a gym\'s status, and nothing is written',
  async (role) => {
    as(role);

    const response = await post({ organization_id: 'gym-1', status: 'suspended' });

    expect(response.status).toBe(403);
    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  },
);

test.each(['suspended', 'inactive', 'pending', 'active'])(
  'the platform evidence shelf is not a gym: setting it %s is refused, nothing written',
  async (status) => {
    const response = await post({ organization_id: ` ${PLATFORM_LIBRARY_ORGANIZATION_ID} `, status });

    expect(response.status).toBe(400);
    expect(mockSetStatus).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  },
);

test('a missing id or an unknown status is refused before anything is written', async () => {
  await expect(post({ status: 'active' }).then((r) => r.status)).resolves.toBe(400);
  await expect(post({ organization_id: 'gym-1' }).then((r) => r.status)).resolves.toBe(400);
  await expect(post({ organization_id: 'gym-1', status: 'frozen' }).then((r) => r.status)).resolves.toBe(400);
  expect(mockSetStatus).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

// F-085: the desk could close Root, or the gym the platform owner's own
// session is scoped to -- which revokes that session and everyone homed there.
// Both are refused for every standing that signs people out; opening either
// is still allowed, because that is the way back.
describe("Root and the caller's own gym cannot be closed from the desk", () => {
  const targets = [
    { name: 'Root', id: getPilotDefaultOrganizationId() },
    // as('platform_owner') above scopes the session to this organization.
    { name: "the caller's own gym", id: 'platform' },
  ];
  const signOutStandings = ['inactive', 'suspended', 'pending'];

  test.each(targets.flatMap((target) => signOutStandings.map((status) => ({ ...target, status }))))(
    '$name: setting it $status is refused and nothing is written',
    async ({ id, status }) => {
      const response = await post({ organization_id: ` ${id} `, status });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: expect.stringContaining('Root and the gym you are signed in to cannot be closed'),
      });
      expect(mockSetStatus).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    },
  );

  test.each(targets)('$name: opening it is still allowed', async ({ id }) => {
    const response = await post({ organization_id: id, status: 'active' });

    expect(response.status).toBe(200);
    expect(mockSetStatus).toHaveBeenCalledWith(id, 'active');
    expect(mockAudit).toHaveBeenCalledTimes(1);
  });

  test('another gym still closes', async () => {
    const response = await post({ organization_id: 'gym-1', status: 'inactive' });

    expect(response.status).toBe(200);
    expect(mockSetStatus).toHaveBeenCalledWith('gym-1', 'inactive');
  });
});
