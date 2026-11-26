import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listOnTheFloorForStaff } from '@/src/server/pilot/onTheFloor';

/*
 * The on-the-floor route (lane W4-3, FN-1). Who counts is onTheFloor.pg.test.ts;
 * this file pins who may ask: coach, organization_admin and admin (OVERWATCH: GO
 * W4-3 on #2192), with the module's own staff-membership refusal passed through.
 * Parents and athletes are refused until FN-2.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/onTheFloor', () => ({ listOnTheFloorForStaff: jest.fn() }));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockList = listOnTheFloorForStaff as jest.Mock;

const URL = 'http://localhost/api/pilot/on-the-floor';
const LINE = { day: '2026-11-25', athletes: [{ athlete_id: 'a-1', full_name: 'Ada' }] };

function principal(role: string, organizationId = 'org-1') {
  return { accountId: `acct-${role}`, role, organizationId, athleteId: null, sessionToken: 'secret', authProvider: 'microsoft' };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue(LINE);
});

it.each(['coach', 'organization_admin', 'admin'])('a %s reads its own gym\'s line, not cached', async (role) => {
  mockPrincipal.mockResolvedValue(principal(role));
  const response = await GET(new NextRequest(URL));
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ ok: true, ...LINE });
  expect(mockList).toHaveBeenCalledTimes(1);
  const [actor, now] = mockList.mock.calls[0];
  expect(actor).toMatchObject({ accountId: `acct-${role}`, role, organizationId: 'org-1' });
  expect(now).toBeInstanceOf(Date);
});

it.each(['athlete', 'parent', 'board', 'volunteer', 'staff', 'platform_owner'])('a %s is refused before anything is read', async (role) => {
  mockPrincipal.mockResolvedValue(principal(role));
  const response = await GET(new NextRequest(URL));
  expect(response.status).toBe(403);
  expect(mockList).not.toHaveBeenCalled();
});

it('a coach with no active staff membership here is refused (the module\'s 403 passes through), not given an empty line', async () => {
  mockPrincipal.mockResolvedValue(principal('coach'));
  mockList.mockImplementation(async () => {
    const { ForbiddenError } = jest.requireActual('@/src/server/pilot/errors');
    throw new ForbiddenError('Forbidden: only a coach or the gym admin of this gym reads who is on the floor');
  });
  const response = await GET(new NextRequest(URL));
  expect(response.status).toBe(403);
  expect(await response.json()).not.toHaveProperty('athletes');
});

it.each([
  'organization_id=org-2',
  'athlete_id=a-9',
  'day=2026-11-24',
])('refuses a query that names anything (%s), before anything is read', async (query) => {
  mockPrincipal.mockResolvedValue(principal('coach'));
  const response = await GET(new NextRequest(`${URL}?${query}`));
  expect(response.status).toBe(400);
  expect(mockList).not.toHaveBeenCalled();
});

it('a failed read is a 500 with no detail and no list, never an empty line', async () => {
  mockPrincipal.mockResolvedValue(principal('coach'));
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mockList.mockRejectedValue(Object.assign(new Error('relation "pilot.x" does not exist for athlete a-1'), { code: '42P01' }));
    const response = await GET(new NextRequest(URL));
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({ error: 'Internal server error' });
    // The log line carries the error class and code only: no message, so no athlete id.
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('a-1');
  } finally {
    consoleError.mockRestore();
  }
});

it('a caller with no session is refused before anything is read', async () => {
  mockPrincipal.mockRejectedValue(new Error('Unauthorized'));
  const response = await GET(new NextRequest(URL));
  expect(response.status).toBe(401);
  expect(mockList).not.toHaveBeenCalled();
});
