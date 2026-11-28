import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listOnTheFloorForStaff, onTheFloorForFamily } from '@/src/server/pilot/onTheFloor';

/*
 * The on-the-floor route (lane W4-3). Who counts is onTheFloor.pg.test.ts; this
 * file pins who may ask and what each is answered: coach, organization_admin and
 * admin the staff line (FN-1), a parent and an athlete the family line (FN-2),
 * per OVERWATCH: GO W4-3 on #2192. A family is answered with on_the_floor alone,
 * and a family's failure is one fixed text whatever the cause (FN-0 F1, F15).
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/onTheFloor', () => ({ listOnTheFloorForStaff: jest.fn(), onTheFloorForFamily: jest.fn() }));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockStaff = listOnTheFloorForStaff as jest.Mock;
const mockFamily = onTheFloorForFamily as jest.Mock;

const URL = 'http://localhost/api/pilot/on-the-floor';
const LINE = { day: '2026-11-25', athletes: [{ athlete_id: 'a-1', full_name: 'Ada' }] };
const FAMILY_FAILURE = { error: 'Not available' };

function principal(role: string, organizationId = 'org-1', athleteId: string | null = null) {
  return { accountId: `acct-${role}`, role, organizationId, athleteId, sessionToken: 'secret', authProvider: 'microsoft' };
}

function forbidden(message: string) {
  const { ForbiddenError } = jest.requireActual('@/src/server/pilot/errors');
  return new ForbiddenError(message);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockStaff.mockResolvedValue(LINE);
  mockFamily.mockImplementation(async (actor: { role: string }) =>
    actor.role === 'parent' ? { reader: 'parent', on_the_floor: ['a-1'] } : { reader: 'athlete', on_the_floor: true });
});

it.each(['coach', 'organization_admin', 'admin'])('a %s reads its own gym\'s staff line, not cached', async (role) => {
  mockPrincipal.mockResolvedValue(principal(role));
  const response = await GET(new NextRequest(URL));
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ ok: true, ...LINE });
  expect(mockStaff).toHaveBeenCalledTimes(1);
  expect(mockFamily).not.toHaveBeenCalled();
  const [actor, now] = mockStaff.mock.calls[0];
  expect(actor).toMatchObject({ accountId: `acct-${role}`, role, organizationId: 'org-1' });
  expect(now).toBeInstanceOf(Date);
});

it('a parent is answered with their own children who count, by id, and nothing else; not cached', async () => {
  mockPrincipal.mockResolvedValue(principal('parent'));
  const response = await GET(new NextRequest(URL));
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ ok: true, on_the_floor: ['a-1'] });
  expect(mockStaff).not.toHaveBeenCalled();
  expect(mockFamily).toHaveBeenCalledTimes(1);
  const [actor, now] = mockFamily.mock.calls[0];
  expect(actor).toMatchObject({ accountId: 'acct-parent', role: 'parent', organizationId: 'org-1' });
  expect(now).toBeInstanceOf(Date);
});

it('an athlete is answered yes or no about themselves, and nothing else', async () => {
  mockPrincipal.mockResolvedValue(principal('athlete', 'org-1', 'a-7'));
  const response = await GET(new NextRequest(URL));
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ ok: true, on_the_floor: true });
  expect(mockStaff).not.toHaveBeenCalled();
  expect(mockFamily.mock.calls[0][0]).toMatchObject({ role: 'athlete', athleteId: 'a-7' });
});

it.each(['board', 'volunteer', 'staff', 'platform_owner'])('a %s is refused before anything is read', async (role) => {
  mockPrincipal.mockResolvedValue(principal(role));
  const response = await GET(new NextRequest(URL));
  expect(response.status).toBe(403);
  expect(mockStaff).not.toHaveBeenCalled();
  expect(mockFamily).not.toHaveBeenCalled();
});

it('a coach with no active staff membership here is refused (the module\'s 403 passes through), not given an empty line', async () => {
  mockPrincipal.mockResolvedValue(principal('coach'));
  mockStaff.mockRejectedValue(forbidden('Forbidden: only a coach or the gym admin of this gym reads who is on the floor'));
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
  expect(mockStaff).not.toHaveBeenCalled();
});

it.each(['parent', 'athlete'])('a %s naming an athlete or a gym in the query is refused with the one fixed text, before anything is read', async (role) => {
  mockPrincipal.mockResolvedValue(principal(role, 'org-1', role === 'athlete' ? 'a-7' : null));
  const response = await GET(new NextRequest(`${URL}?athlete_id=a-9&organization_id=org-2`));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual(FAMILY_FAILURE);
  expect(mockFamily).not.toHaveBeenCalled();
  expect(mockStaff).not.toHaveBeenCalled();
});

it('a family refusal is the one fixed text, with no id and no reason passed through (FN-0 F15)', async () => {
  mockPrincipal.mockResolvedValue(principal('athlete'));
  mockFamily.mockRejectedValue(forbidden('Forbidden: athlete a-1 is not linked'));
  const response = await GET(new NextRequest(URL));
  expect(response.status).toBe(403);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.json()).toEqual(FAMILY_FAILURE);
});

// Codex on #2220 (4723722713); App Overwatch 7228636120. The module now refuses a session that outlived
// the athlete's record (onTheFloor.pg.test.ts proves that); this pins what the route makes of that refusal:
// a 403, the status the other athlete-self routes give it (assertAthleteBelongsToOrganization), with the
// family's one fixed text and no "not counted" answer. The route itself is unchanged by the fix.
it('an athlete whose record is gone is refused with a 403 and the one fixed text, never "not counted"', async () => {
  mockPrincipal.mockResolvedValue(principal('athlete', 'org-1', 'a-gone'));
  mockFamily.mockRejectedValue(forbidden('Forbidden: athlete does not belong to organization'));
  const response = await GET(new NextRequest(URL));
  expect(response.status).toBe(403);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  const body = await response.json();
  expect(body).toEqual(FAMILY_FAILURE);
  expect(body).not.toHaveProperty('on_the_floor');
});

it.each(['parent', 'athlete'])('a failed %s read is a 500 with the one fixed text, and no id in the log', async (role) => {
  mockPrincipal.mockResolvedValue(principal(role, 'org-1', role === 'athlete' ? 'a-7' : null));
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mockFamily.mockRejectedValue(Object.assign(new Error('relation "pilot.x" does not exist for athlete a-1'), { code: '42P01' }));
    const response = await GET(new NextRequest(URL));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(FAMILY_FAILURE);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('a-1');
  } finally {
    consoleError.mockRestore();
  }
});

it('a failed staff read is a 500 with no detail and no list, never an empty line', async () => {
  mockPrincipal.mockResolvedValue(principal('coach'));
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    mockStaff.mockRejectedValue(Object.assign(new Error('relation "pilot.x" does not exist for athlete a-1'), { code: '42P01' }));
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
  expect(mockStaff).not.toHaveBeenCalled();
  expect(mockFamily).not.toHaveBeenCalled();
});
