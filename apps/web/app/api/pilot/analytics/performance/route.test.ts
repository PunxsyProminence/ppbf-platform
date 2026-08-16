import { NextRequest } from 'next/server';

import { GET } from './route';
import { getAthletesByOrganization, getAthletesForCoach } from '@/src/server/pilot/entities';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getPerformanceRollup } from '@/src/server/pilot/performanceAnalytics';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/entities', () => ({
  getAthletesByOrganization: jest.fn(),
  getAthletesForCoach: jest.fn(),
}));

jest.mock('@/src/server/pilot/performanceAnalytics', () => {
  const actual = jest.requireActual('@/src/server/pilot/performanceAnalytics');
  return { ...actual, getPerformanceRollup: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockForCoach = getAthletesForCoach as jest.Mock;
const mockForOrg = getAthletesByOrganization as jest.Mock;
const mockRollup = getPerformanceRollup as jest.Mock;

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
    authProvider: 'ppbf_local',
    ...overrides,
  } as PilotPrincipal;
}

function getRequest(query = '') {
  return new NextRequest(`http://localhost/api/pilot/analytics/performance${query ? `?${query}` : ''}`);
}

const ROLLUP_ROW = {
  athlete_id: 'ath-1',
  sessions_total: 4,
  sessions_completed: 3,
  avg_rpe: 6.5,
  training_days: 8,
  readiness_count: 6,
  avg_readiness: 7.1,
  readiness_early_avg: 6.8,
  readiness_late_avg: 7.4,
  open_gaps: 1,
  active_assignments: 2,
  avg_assignment_completion: 55,
};

// This is a staff reporting surface. An athlete or a parent must never reach
// the org-wide rollup, and a coach must be scoped by the SAME roster
// projection the roster read applies -- never the whole organization.
describe('role gating', () => {
  test.each(['athlete', 'parent', 'board', 'volunteer'] as const)('%s is forbidden', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

    const response = await GET(getRequest());

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockForCoach).not.toHaveBeenCalled();
    expect(mockForOrg).not.toHaveBeenCalled();
    expect(mockRollup).not.toHaveBeenCalled();
  });

  test('a coach is scoped through getAthletesForCoach, not the whole organization', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach', accountId: 'coach-9' }));
    mockForCoach.mockResolvedValue([{ athlete_id: 'ath-1', full_name: 'Jordan Doe' }]);
    mockRollup.mockResolvedValue([ROLLUP_ROW]);

    const response = await GET(getRequest());
    const payload = await response.json();

    expect(mockForCoach).toHaveBeenCalledWith('org-1', 'coach-9');
    expect(mockForOrg).not.toHaveBeenCalled();
    expect(mockRollup).toHaveBeenCalledWith('org-1', ['ath-1'], 28);
    expect(payload.items[0].full_name).toBe('Jordan Doe');
    expect(payload.items[0].avg_readiness).toBe(7.1);
  });

  test('an organization admin reads the whole organization roster', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
    mockForOrg.mockResolvedValue([
      { athlete_id: 'ath-1', full_name: 'Jordan Doe' },
      { athlete_id: 'ath-2', full_name: 'Riley Doe' },
    ]);
    mockRollup.mockResolvedValue([ROLLUP_ROW, { ...ROLLUP_ROW, athlete_id: 'ath-2' }]);

    const response = await GET(getRequest());
    const payload = await response.json();

    expect(mockForOrg).toHaveBeenCalledWith('org-1');
    expect(mockForCoach).not.toHaveBeenCalled();
    expect(payload.items).toHaveLength(2);
  });
});

describe('window clamping', () => {
  beforeEach(() => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
    mockForOrg.mockResolvedValue([{ athlete_id: 'ath-1', full_name: 'Jordan Doe' }]);
    mockRollup.mockResolvedValue([ROLLUP_ROW]);
  });

  test('missing window_days defaults to 28', async () => {
    const payload = await (await GET(getRequest())).json();
    expect(payload.window_days).toBe(28);
  });

  test('an absurd window is clamped instead of trusted', async () => {
    const payload = await (await GET(getRequest('window_days=99999'))).json();
    expect(payload.window_days).toBe(365);
    expect(mockRollup).toHaveBeenCalledWith('org-1', ['ath-1'], 365);
  });

  test('a non-numeric window falls back to the default', async () => {
    const payload = await (await GET(getRequest('window_days=soon'))).json();
    expect(payload.window_days).toBe(28);
  });
});
