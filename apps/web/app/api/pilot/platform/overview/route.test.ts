// The platform owner's all-gyms overview is aggregates: each gym's board
// summary, growth metrics and a count of the capabilities switched on. It used
// to select every gym's track assignments as well -- a map keyed by athlete id,
// one entry per athlete -- to produce a count no screen showed. Now that those
// keys are real athletes (OD-2026-10-07-010 ruling 3), that map is not the
// platform account's to read (OD-2026-09-28-005; OD-2026-10-08-003 R2).

import { NextRequest } from 'next/server';

import { GET } from './route';
import { getBoardSummary } from '@/src/server/pilot/boardSummary';
import { query } from '@/src/server/pilot/db';
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
const mockQuery = query as jest.Mock;
const mockBoard = jest.mocked(getBoardSummary);
const mockGrowth = jest.mocked(getGrowthMetrics);

const ATHLETE_ID = 'ath-real-0001';

function as(role: string) {
  mockPrincipal.mockResolvedValue({ accountId: `${role}-1`, organizationId: '__platform__', role } as never);
}

const get = () => new NextRequest('http://localhost/api/pilot/platform/overview');

const sqlRun = () => mockQuery.mock.calls.map(([sql]) => String(sql));

beforeEach(() => {
  jest.resetAllMocks();
  as('platform_owner');
  mockBoard.mockResolvedValue({ athletes: 12 } as never);
  mockGrowth.mockResolvedValue({ sessions: 40 } as never);
  // Answer by what is asked. If the route ever reads the track map again it
  // gets a real-looking one, so the assertions below would see it come back.
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('admin_track_assignments')) {
      return [{ organization_id: 'gym-a', assignments: { [ATHLETE_ID]: ['non_contact', 'usa_boxing'] } }];
    }
    if (sql.includes('admin_gym_capability_access')) {
      return [{ organization_id: 'gym-a', capability_access: { film_study: true, sparring: false, video: true } }];
    }
    if (sql.includes('pilot.organizations')) {
      return [
        { organization_id: 'gym-a', organization_name: 'Gym A', status: 'active' },
        { organization_id: 'gym-b', organization_name: 'Gym B', status: 'active' },
      ];
    }
    return [];
  });
});

test('the platform owner still gets each gym\'s aggregates', async () => {
  const response = await GET(get());

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    gyms: [
      {
        organizationId: 'gym-a',
        organizationName: 'Gym A',
        status: 'active',
        board: { athletes: 12 },
        growth: { sessions: 40 },
        capabilityCount: 2,
      },
      {
        organizationId: 'gym-b',
        organizationName: 'Gym B',
        status: 'active',
        board: { athletes: 12 },
        growth: { sessions: 40 },
        capabilityCount: 0,
      },
    ],
  });
});

test('the overview carries no track assignments, no track count and no athlete id', async () => {
  const response = await GET(get());
  const text = await response.text();

  expect(text).not.toContain(ATHLETE_ID);
  expect(text).not.toMatch(/track/i);
  for (const gym of (JSON.parse(text) as { gyms: Array<Record<string, unknown>> }).gyms) {
    expect(gym).not.toHaveProperty('trackAssignmentCount');
    expect(gym).not.toHaveProperty('trackAssignments');
  }
});

test('no gym\'s track map is read at all', async () => {
  await GET(get());

  expect(sqlRun().some((sql) => sql.includes('admin_gym_capability_access'))).toBe(true);
  expect(sqlRun().some((sql) => sql.includes('admin_track_assignments'))).toBe(false);
});

test('a gym whose summary fails still carries no track field', async () => {
  mockBoard.mockRejectedValueOnce(new Error('boom'));
  const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);

  const response = await GET(get());
  const body = (await response.json()) as { gyms: Array<Record<string, unknown>> };
  error.mockRestore();

  const failed = body.gyms.find((gym) => gym.error);
  expect(failed).toMatchObject({ board: null, growth: null, error: 'Failed to load summary' });
  expect(failed).not.toHaveProperty('trackAssignmentCount');
});

test.each(['organization_admin', 'admin', 'coach', 'athlete', 'parent', 'board'])(
  '%s is refused, and nothing is read',
  async (role) => {
    as(role);

    const response = await GET(get());

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  },
);
