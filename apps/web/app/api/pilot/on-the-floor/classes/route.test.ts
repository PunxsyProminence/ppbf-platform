import { NextRequest } from 'next/server';

import { GET } from './route';
import { classesRunningNow, registerTotalToday } from '@/src/server/pilot/floorCount';
import { listLiveTvRounds } from '@/src/server/pilot/gymTvs';
import { requirePrincipal } from '@/src/server/pilot/http';

/*
 * The classes line's route (lane W4-3, FN-4a; GO on #2192, 7206014991). What counts is
 * floorCount.pg.test.ts; this file pins who may ask and exactly what each is answered:
 *   - the board: classes without a count, rounds, and one floored total (0 to 4 "Suppressed", flag 3);
 *   - staff-role and volunteer accounts: classes with each one's count, rounds, no total;
 *   - coaches and gym admins: classes without a count, rounds, no total (QG A);
 *   - the platform owner, parents and athletes: 403, with nothing read.
 * No answer carries a name, initials, an id, or a run, script or coach field: each key set is exact.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/floorCount', () => {
  const actual = jest.requireActual('@/src/server/pilot/floorCount');
  return { ...actual, classesRunningNow: jest.fn(), registerTotalToday: jest.fn() };
});

jest.mock('@/src/server/pilot/gymTvs', () => ({ listLiveTvRounds: jest.fn() }));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockClasses = classesRunningNow as jest.Mock;
const mockTotal = registerTotalToday as jest.Mock;
const mockRounds = listLiveTvRounds as jest.Mock;

const URL = 'http://localhost/api/pilot/on-the-floor/classes';

// The modules' rows, with fields a careless change might pass through: none may reach the answer.
const CLASS_ROW = {
  title: 'Bag work',
  start_at: '2026-11-25T19:30:00.000Z',
  end_at: '2026-11-25T20:30:00.000Z',
  room: 'Ring 1',
  count: 3,
  class_id: 'class-1',
  coach_account_id: 'coach@gym',
};
const ROUND_ROW = {
  tv_name: 'Ring TV',
  phase: 'work',
  round: 2,
  rounds_total: 5,
  is_paused: false,
  run_id: 'run-1',
  script_name: 'Plan',
};

const CLASS_SHOWN = { title: 'Bag work', start_at: '2026-11-25T19:30:00.000Z', end_at: '2026-11-25T20:30:00.000Z', room: 'Ring 1' };
const ROUND_SHOWN = { tv_name: 'Ring TV', phase: 'work', round: 2, rounds_total: 5, is_paused: false };

function principal(role: string, organizationId = 'org-1') {
  return { accountId: `acct-${role}`, role, organizationId, athleteId: null, sessionToken: 'secret', authProvider: 'microsoft' };
}

async function read(role: string, url = URL) {
  mockPrincipal.mockResolvedValue(principal(role));
  const response = await GET(new NextRequest(url));
  return { response, body: await response.json() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockClasses.mockResolvedValue([CLASS_ROW]);
  mockRounds.mockResolvedValue([ROUND_ROW]);
  mockTotal.mockResolvedValue(7);
});

describe('the board', () => {
  it('gets the classes without a count, the rounds, and one floored total; exactly those keys; not cached', async () => {
    const { response, body } = await read('board');
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(Object.keys(body).sort()).toEqual(['classes', 'ok', 'read_at', 'rounds', 'total']);
    expect(body.ok).toBe(true);
    expect(body.classes).toEqual([CLASS_SHOWN]);
    expect(Object.keys(body.classes[0]).sort()).toEqual(['end_at', 'room', 'start_at', 'title']);
    expect(body.rounds).toEqual([ROUND_SHOWN]);
    expect(Object.keys(body.rounds[0]).sort()).toEqual(['is_paused', 'phase', 'round', 'rounds_total', 'tv_name']);
    expect(body.total).toEqual({ status: 'available', count: 7 });
  });

  it.each([
    [0, { status: 'insufficient_data', count: null }],
    [4, { status: 'insufficient_data', count: null }],
    [5, { status: 'available', count: 5 }],
  ])('a total of %i shows as %j (flag 3: 0 to 4 suppressed, live or not)', async (total, shown) => {
    mockTotal.mockResolvedValue(total);
    const { body } = await read('board');
    expect(body.total).toEqual(shown);
  });

  it('reads its own gym, at one moment, and says when', async () => {
    const before = Date.now();
    const { body } = await read('board');
    expect(mockClasses).toHaveBeenCalledWith('org-1', expect.any(Date));
    expect(mockRounds).toHaveBeenCalledWith('org-1', expect.any(Date));
    expect(mockTotal).toHaveBeenCalledWith('org-1', expect.any(Date));
    const moments = [mockClasses, mockRounds, mockTotal].map((mock) => (mock.mock.calls[0][1] as Date).toISOString());
    expect(new Set(moments).size).toBe(1);
    expect(body.read_at).toBe(moments[0]);
    expect(Date.parse(body.read_at)).toBeGreaterThanOrEqual(before);
  });
});

describe.each(['staff', 'volunteer'])('a %s account', (role) => {
  it('gets each class with its exact count, the rounds, and no total; exactly those keys', async () => {
    const { response, body } = await read(role);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(Object.keys(body).sort()).toEqual(['classes', 'ok', 'read_at', 'rounds']);
    expect(body.classes).toEqual([{ ...CLASS_SHOWN, count: 3 }]);
    expect(Object.keys(body.classes[0]).sort()).toEqual(['count', 'end_at', 'room', 'start_at', 'title']);
    expect(body.rounds).toEqual([ROUND_SHOWN]);
    expect(mockTotal).not.toHaveBeenCalled();
  });
});

describe.each(['coach', 'organization_admin', 'admin'])('a %s', (role) => {
  it('gets the classes without a count and the rounds, and no total (QG A); exactly those keys', async () => {
    const { response, body } = await read(role);
    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['classes', 'ok', 'read_at', 'rounds']);
    expect(body.classes).toEqual([CLASS_SHOWN]);
    expect(body.rounds).toEqual([ROUND_SHOWN]);
    expect(mockTotal).not.toHaveBeenCalled();
  });
});

describe('refusals', () => {
  it.each(['platform_owner', 'parent', 'athlete', 'unknown_role'])('a %s is refused (403) with nothing read', async (role) => {
    const { response, body } = await read(role);
    expect(response.status).toBe(403);
    expect(body).not.toHaveProperty('classes');
    expect(mockClasses).not.toHaveBeenCalled();
    expect(mockRounds).not.toHaveBeenCalled();
    expect(mockTotal).not.toHaveBeenCalled();
  });

  it('no session is refused (401) with nothing read', async () => {
    mockPrincipal.mockRejectedValue(new Error('Unauthorized'));
    const response = await GET(new NextRequest(URL));
    expect(response.status).toBe(401);
    expect(mockClasses).not.toHaveBeenCalled();
    expect(mockRounds).not.toHaveBeenCalled();
  });

  it.each(['?organization_id=org-2', '?gym=other', '?x='])('a query field (%s) is refused with nothing read', async (query) => {
    const { response } = await read('board', `${URL}${query}`);
    expect(response.status).toBe(400);
    expect(mockClasses).not.toHaveBeenCalled();
    expect(mockRounds).not.toHaveBeenCalled();
    expect(mockTotal).not.toHaveBeenCalled();
  });
});

describe('a failure anywhere fails the whole read, never a partial or zero answer', () => {
  it.each([
    ['the classes read', () => mockClasses.mockRejectedValue(new Error('db down'))],
    ['the rounds read, or its idle close', () => mockRounds.mockRejectedValue(new Error('close failed'))],
    ['the total', () => mockTotal.mockRejectedValue(new Error('db down'))],
  ])('%s', async (_label, arrange) => {
    arrange();
    const { response, body } = await read('board');
    expect(response.status).toBe(500);
    expect(body).not.toHaveProperty('classes');
    expect(body).not.toHaveProperty('total');
    expect(body).not.toHaveProperty('rounds');
  });
});
