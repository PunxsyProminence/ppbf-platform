// The platform owner's view of one gym is aggregates: board summary, growth
// metrics, which capabilities are switched on. It used to carry the gym's
// track assignments as well -- a map keyed by athlete id, one row per athlete
// -- which is an individual athlete's record and not the platform account's to
// open (OD-2026-09-28-005; OD-2026-10-08-003 R2).

import { NextRequest } from 'next/server';

import { GET } from './route';
import { getBoardSummary } from '@/src/server/pilot/boardSummary';
import { queryOne } from '@/src/server/pilot/db';
import { registerTotalToday } from '@/src/server/pilot/floorCount';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getGrowthMetrics } from '@/src/server/pilot/shadowMetrics';

// requireRole (access.ts) and jsonError stay real.
jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('@/src/server/pilot/boardSummary', () => ({
  ...jest.requireActual('@/src/server/pilot/boardSummary'),
  getBoardSummary: jest.fn(),
}));
// The register count is floorCount.pg.test.ts's; the floor applied to it here is the real one.
jest.mock('@/src/server/pilot/floorCount', () => ({
  ...jest.requireActual('@/src/server/pilot/floorCount'),
  registerTotalToday: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowMetrics', () => ({ getGrowthMetrics: jest.fn() }));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockQueryOne = queryOne as jest.Mock;
const mockBoard = jest.mocked(getBoardSummary);
const mockGrowth = jest.mocked(getGrowthMetrics);
const mockTotal = registerTotalToday as jest.Mock;

const ATHLETE_ID = 'ath-real-0001';

function as(role: string) {
  mockPrincipal.mockResolvedValue({ accountId: `${role}-1`, organizationId: '__platform__', role } as never);
}

function get(query = '?organization_id=gym-a') {
  return new NextRequest(`http://localhost/api/pilot/platform/gym-summary${query}`);
}

beforeEach(() => {
  jest.resetAllMocks();
  as('platform_owner');
  mockBoard.mockResolvedValue({ athletes: 12 } as never);
  mockGrowth.mockResolvedValue({ sessions: 40 } as never);
  mockTotal.mockResolvedValue(12);
  // Answer by what is asked. If the route ever reads the track map again, it
  // gets a real-looking one, so the assertions below would see it come back.
  mockQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('admin_track_assignments')) {
      return { assignments: { [ATHLETE_ID]: ['non_contact', 'usa_boxing'] } };
    }
    if (sql.includes('admin_gym_capability_access')) {
      return { capability_access: { film_study: true, sparring: false } };
    }
    return null;
  });
});

test('the platform owner still gets the named gym\'s summary', async () => {
  const response = await GET(get());

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    organization_id: 'gym-a',
    board: { athletes: 12 },
    growth: { sessions: 40 },
    capabilityAccess: { film_study: true, sparring: false },
    on_the_floor: { status: 'available', count: 12 },
  });
  expect(mockBoard).toHaveBeenCalledWith('gym-a');
  expect(mockGrowth).toHaveBeenCalledWith('gym-a');
});

test('the summary carries no track assignments and no athlete id', async () => {
  const response = await GET(get());
  const text = await response.text();

  expect(JSON.parse(text)).not.toHaveProperty('trackAssignments');
  expect(text).not.toContain(ATHLETE_ID);
  expect(text).not.toContain('usa_boxing');
});

test('the track assignments table is not read at all', async () => {
  await GET(get());

  const sqls = mockQueryOne.mock.calls.map(([sql]) => String(sql));
  expect(sqls).toHaveLength(1);
  expect(sqls[0]).toContain('pilot.admin_gym_capability_access');
  expect(sqls.some((sql) => sql.includes('admin_track_assignments'))).toBe(false);
});

test('a missing organization_id is a 400 and reads nothing', async () => {
  const response = await GET(get(''));

  expect(response.status).toBe(400);
  expect(mockBoard).not.toHaveBeenCalled();
  expect(mockQueryOne).not.toHaveBeenCalled();
});

// Unchanged by this lane: the cross-gym summary is the platform owner's only.
test.each(['organization_admin', 'admin', 'coach', 'board', 'athlete'])('role %s is refused', async (role) => {
  as(role);

  const response = await GET(get());

  expect(response.status).toBe(403);
  expect(mockBoard).not.toHaveBeenCalled();
  expect(mockQueryOne).not.toHaveBeenCalled();
});

// Lane W4-3, FN-4c (GO on #2192, 7206014991; QC A): how many are here now, for the chosen gym, floored.
describe('on the floor now', () => {
  test.each([
    [0, { status: 'insufficient_data', count: null }],
    [4, { status: 'insufficient_data', count: null }],
    [5, { status: 'available', count: 5 }],
  ])('a total of %i reads %j: 0 to 4 suppressed, live or not (flag 3)', async (total, shown) => {
    mockTotal.mockResolvedValue(total);
    const body = await (await GET(get())).json();
    expect(body.on_the_floor).toEqual(shown);
  });

  test('is counted for the gym the platform owner named, at the current moment, and is not cached', async () => {
    const before = Date.now();
    const response = await GET(get('?organization_id=gym-b'));
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mockTotal).toHaveBeenCalledTimes(1);
    const [organizationId, now] = mockTotal.mock.calls[0];
    expect(organizationId).toBe('gym-b');
    expect((now as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect((now as Date).getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('a failed count fails the summary, never a zero', async () => {
    mockTotal.mockRejectedValue(new Error('db down'));
    const response = await GET(get());
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty('on_the_floor');
  });

  test('nothing is counted for a role the route refuses, or without a gym', async () => {
    as('board');
    expect((await GET(get())).status).toBe(403);
    as('platform_owner');
    expect((await GET(get(''))).status).toBe(400);
    expect(mockTotal).not.toHaveBeenCalled();
  });
});
