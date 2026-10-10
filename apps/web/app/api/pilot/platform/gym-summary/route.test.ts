// The platform owner's view of one gym is aggregates: board summary, growth
// metrics, which capabilities are switched on. It used to carry the gym's
// track assignments as well -- a map keyed by athlete id, one row per athlete
// -- which is an individual athlete's record and not the platform account's to
// open (OD-2026-09-28-005; OD-2026-10-08-003 R2).

import { NextRequest } from 'next/server';

import { GET } from './route';
import { getBoardSummary } from '@/src/server/pilot/boardSummary';
import { queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getGrowthMetrics } from '@/src/server/pilot/shadowMetrics';

// requireRole (access.ts) and jsonError stay real.
jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('@/src/server/pilot/boardSummary', () => ({ getBoardSummary: jest.fn() }));
jest.mock('@/src/server/pilot/shadowMetrics', () => ({ getGrowthMetrics: jest.fn() }));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockQueryOne = queryOne as jest.Mock;
const mockBoard = jest.mocked(getBoardSummary);
const mockGrowth = jest.mocked(getGrowthMetrics);

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
