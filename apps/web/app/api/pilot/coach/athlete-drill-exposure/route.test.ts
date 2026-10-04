import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getAthleteDrillExposure } from '@/src/server/pilot/athleteDrillExposure';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/athleteDrillExposure', () => {
  const actual = jest.requireActual('@/src/server/pilot/athleteDrillExposure');
  return { ...actual, getAthleteDrillExposure: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockRead = getAthleteDrillExposure as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = (query = 'athlete_id=ath-1&from=2026-09-01&to=2026-09-30') =>
  new NextRequest(`http://localhost/api/pilot/coach/athlete-drill-exposure?${query}`);

test('non-staff roles have no path to an exposure read', async () => {
  for (const role of ['athlete', 'parent', 'platform_owner', 'board', 'staff', 'volunteer'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockRead).not.toHaveBeenCalled();
});

test('the read is org-scoped from the principal, needs an athlete, and passes the window', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockResolvedValue(undefined);

  expect((await GET(getRequest('from=2026-09-01'))).status).toBe(400);
  expect(mockRead).not.toHaveBeenCalled();

  mockRead.mockResolvedValue({ athleteId: 'ath-1' });
  const response = await GET(getRequest('athlete_id=ath-1&from=2026-09-01&to=2026-09-30&organization_id=org-2'));

  expect(response.status).toBe(200);
  expect(mockRead).toHaveBeenCalledWith({
    organizationId: 'org-1',
    athleteId: 'ath-1',
    window: { from: '2026-09-01', to: '2026-09-30' },
  });
});

test('a caller the access contract refuses gets no read -- including for a deleted athlete', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  for (const message of [
    'Forbidden: coach not assigned to athlete',
    'Forbidden: athlete does not belong to organization',
  ]) {
    mockAccess.mockRejectedValueOnce(new Error(message));
    const response = await GET(getRequest());
    expect(response.status).toBe(403);
  }
  expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), 'ath-1');
  expect(mockRead).not.toHaveBeenCalled();
});

test('the access check runs before the window is validated', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

  const response = await GET(getRequest('athlete_id=ath-1&from=not-a-date'));
  expect(response.status).toBe(403);
});

test('a bad window is a 400, not a read', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockResolvedValue(undefined);

  for (const query of [
    'athlete_id=ath-1&from=2026-09-30&to=2026-09-01',
    'athlete_id=ath-1&from=2025-01-01&to=2026-09-30',
    'athlete_id=ath-1&from=2026-02-30&to=2026-03-01',
  ]) {
    expect((await GET(getRequest(query))).status).toBe(400);
  }
  expect(mockRead).not.toHaveBeenCalled();
});
