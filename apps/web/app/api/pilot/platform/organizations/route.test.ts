import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { createOrganization } from '@/src/server/pilot/auth';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';

/*
 * OPERATIONS V1 acceptance points 1 and 38, on the same route.
 *
 * Provisioning a gym is the one thing the platform tier is FOR, and it was
 * the only surface in the acceptance contract with no test of its own: the
 * role gate on the create path was a line of code nothing had ever watched
 * refuse. That gate is also the half of point 38 this route owns -- the
 * other half (platform_owner cannot read an athlete record) lives in
 * access.test.ts, on assertActorCanAccessAthlete. Together they state the
 * whole shape: the platform tier may create the gym and may not look inside
 * it.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/auth', () => ({
  createOrganization: jest.fn(),
}));

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockCreateOrganization = jest.mocked(createOrganization);
const mockQuery = jest.mocked(query);

function principal(role: PilotRole): PilotPrincipal {
  return {
    accountId: `${role}-account`,
    role,
    organizationId: role === 'platform_owner' ? 'platform' : 'org-a',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as PilotPrincipal;
}

function post(body: Record<string, unknown>) {
  return POST(new NextRequest('http://localhost/api/pilot/platform/organizations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function get() {
  return GET(new NextRequest('http://localhost/api/pilot/platform/organizations'));
}

beforeEach(() => {
  jest.resetAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal('platform_owner'));
  mockCreateOrganization.mockResolvedValue(undefined);
  mockQuery.mockResolvedValue([]);
});

test('the platform owner provisions a named organization', async () => {
  const response = await post({ organization_id: 'new-gym', organization_name: 'New Gym' });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    organization_id: 'new-gym',
    organization_name: 'New Gym',
  });
  // Attributed to the acting platform account, and filed under the id the
  // caller named -- a provisioning route that quietly created something else
  // would pass a status assertion and still fail the person using it.
  expect(mockCreateOrganization).toHaveBeenCalledWith('new-gym', 'New Gym', 'platform_owner-account');
});

// Every role below can sign in and can reach this URL. Only one of them may
// bring a gym into existence, and the refusal has to land BEFORE the write,
// not after it.
test.each(['organization_admin', 'admin', 'coach', 'athlete', 'parent', 'board', 'staff', 'volunteer'] as const)(
  '%s cannot provision an organization, and nothing is written',
  async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    const response = await post({ organization_id: 'stolen-gym', organization_name: 'Stolen Gym' });

    expect(response.status).toBe(403);
    expect(mockCreateOrganization).not.toHaveBeenCalled();
  },
);

test.each(['organization_admin', 'coach', 'athlete', 'board'] as const)(
  '%s cannot read the platform roster of gyms either',
  async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    const response = await get();

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  },
);

test('a blank id or name is refused before any organization is created', async () => {
  await expect(post({ organization_name: 'Nameless' }).then((r) => r.status)).resolves.toBe(400);
  await expect(post({ organization_id: '   ', organization_name: 'Padded' }).then((r) => r.status)).resolves.toBe(400);
  await expect(post({ organization_id: 'gym-1' }).then((r) => r.status)).resolves.toBe(400);
  expect(mockCreateOrganization).not.toHaveBeenCalled();
});
