import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { findDuplicateGuardianGroups } from '@/src/server/pilot/duplicateGuardians';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/duplicateGuardians', () => {
  const actual = jest.requireActual('@/src/server/pilot/duplicateGuardians');
  return { ...actual, findDuplicateGuardianGroups: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockFind = findDuplicateGuardianGroups as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = () => new NextRequest('http://localhost/api/pilot/admin/data-quality/duplicate-guardians');

test('the check runs org-scoped for an admin', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockFind.mockResolvedValue([]);

  const response = await GET(getRequest());

  expect(response.status).toBe(200);
  expect(mockFind).toHaveBeenCalledWith('org-1');
});

test('coaches, parents, and athletes cannot run it -- family contact structure is admin work', async () => {
  for (const role of ['coach', 'parent', 'athlete', 'platform_owner'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockFind).not.toHaveBeenCalled();
});
