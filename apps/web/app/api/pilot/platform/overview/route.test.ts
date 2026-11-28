// The platform owner's all-gyms overview is aggregates: each gym's board
// summary, growth metrics and a count of the capabilities switched on. It used
// to select every gym's track assignments as well -- a map keyed by athlete id,
// one entry per athlete -- to produce a count no screen showed. Now that those
// keys are real athletes (OD-2026-10-07-010 ruling 3), that map is not the
// platform account's to read (OD-2026-09-28-005).

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
// The board floor (BOARD_MINIMUM_COHORT_SIZE) and the SHADOW-use floor (flooredShadowUses) stay real;
// only the reads behind them are mocked.
jest.mock('@/src/server/pilot/boardSummary', () => ({
  ...jest.requireActual('@/src/server/pilot/boardSummary'),
  getBoardSummary: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowMetrics', () => ({
  ...jest.requireActual('@/src/server/pilot/shadowMetrics'),
  getGrowthMetrics: jest.fn(),
}));

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
  mockBoard.mockResolvedValue({ activeAthletes: { status: 'available', count: 12 } } as never);
  // The rest of the growth answer is unfloored and must not reach the platform owner.
  mockGrowth.mockResolvedValue({ totalInteractions: 40, avgSatisfaction: 4.5, reviewedOutcomes: 2, newLibrarySources: 1 } as never);
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
        board: { activeAthletes: { status: 'available', count: 12 } },
        shadowUses: { status: 'available', count: 40 },
        capabilityCount: 2,
      },
      {
        organizationId: 'gym-b',
        organizationName: 'Gym B',
        status: 'active',
        board: { activeAthletes: { status: 'available', count: 12 } },
        shadowUses: { status: 'available', count: 40 },
        capabilityCount: 0,
      },
    ],
  });
});

// Lane W5-BUG, B4 (App Overwatch Q1 A on #2269): each gym's SHADOW use is sent only as one floored figure.
describe('SHADOW use is held to the board floor', () => {
  async function shadowUses(totalInteractions: number, activeAthletesStatus = 'available'): Promise<unknown> {
    mockBoard.mockResolvedValue({ activeAthletes: { status: activeAthletesStatus, count: activeAthletesStatus === 'available' ? 12 : null } } as never);
    mockGrowth.mockResolvedValue({ totalInteractions } as never);
    const body = (await (await GET(get())).json()) as { gyms: Array<Record<string, unknown>> };
    expect(body.gyms[0]).not.toHaveProperty('growth');
    return body.gyms[0].shadowUses;
  }

  test.each([0, 4])('%i interactions are suppressed', async (count) => {
    await expect(shadowUses(count)).resolves.toEqual({ status: 'insufficient_data', count: null });
  });

  test('5 interactions, the floor itself, are sent', async () => {
    await expect(shadowUses(5)).resolves.toEqual({ status: 'available', count: 5 });
  });

  test('any count is suppressed while the gym\'s Active Athletes figure is', async () => {
    await expect(shadowUses(40, 'insufficient_data')).resolves.toEqual({ status: 'insufficient_data', count: null });
  });

  test('none of the unfloored growth figures is sent', async () => {
    const text = await (await GET(get())).text();
    for (const key of ['growth', 'totalInteractions', 'avgSatisfaction', 'reviewedOutcomes', 'newLibrarySources']) {
      expect(text).not.toContain(key);
    }
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
  expect(failed).toMatchObject({ board: null, shadowUses: null, error: 'Failed to load summary' });
  expect(failed).not.toHaveProperty('growth');
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
