import { NextRequest } from 'next/server';

import { GET } from './route';
import { athleteIdsForCoach } from '@/src/server/pilot/access';
import { getAthletesByOrganization, getAthletesForCoach } from '@/src/server/pilot/entities';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getGapSuggestions } from '@/src/server/pilot/progressionSuggestions';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, athleteIdsForCoach: jest.fn() };
});

jest.mock('@/src/server/pilot/entities', () => ({
  getAthletesByOrganization: jest.fn(),
  getAthletesForCoach: jest.fn(),
}));

jest.mock('@/src/server/pilot/progressionSuggestions', () => {
  const actual = jest.requireActual('@/src/server/pilot/progressionSuggestions');
  return { ...actual, getGapSuggestions: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockCoachIds = athleteIdsForCoach as jest.Mock;
const mockForCoach = getAthletesForCoach as jest.Mock;
const mockForOrg = getAthletesByOrganization as jest.Mock;
const mockSuggestions = getGapSuggestions as jest.Mock;

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

const request = () => new NextRequest('http://localhost/api/pilot/progression/suggestions');

const SUGGESTION = {
  athlete_id: 'ath-1',
  rule: 'readiness_falling',
  gap_type: 'endurance',
  suggested_description: 'Readiness fell.',
  evidence: { readiness_early_avg: 7, readiness_late_avg: 5.5 },
};

// A suggestion is a machine's unconfirmed observation. Confirmed gaps are
// readable by the athlete and their guardian; suggestions must be readable by
// staff only, and a coach only for the athletes the roster projection already
// grants them.
describe('suggestions stay staff-side', () => {
  test.each(['athlete', 'parent', 'board', 'volunteer'] as const)('%s is forbidden', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

    const response = await GET(request());

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockSuggestions).not.toHaveBeenCalled();
  });

  test('a coach is scoped through athleteIdsForCoach', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach', accountId: 'coach-9' }));
    // The roster read deliberately returns the whole organization (names for
    // rendering); the access contract is what bounds the computation.
    mockForCoach.mockResolvedValue([
      { athlete_id: 'ath-1', full_name: 'Jordan Doe' },
      { athlete_id: 'ath-2', full_name: 'Riley Doe' },
    ]);
    mockCoachIds.mockResolvedValue(['ath-1']);
    mockSuggestions.mockResolvedValue([SUGGESTION]);

    const payload = await (await GET(request())).json();

    expect(mockCoachIds).toHaveBeenCalledWith('org-1', 'coach-9');
    expect(mockForOrg).not.toHaveBeenCalled();
    expect(mockSuggestions).toHaveBeenCalledWith('org-1', ['ath-1']);
    expect(payload.items[0].full_name).toBe('Jordan Doe');
    expect(payload.items[0].rule).toBe('readiness_falling');
  });

  test("an athlete outside the coach's access set never reaches the suggester or the response", async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach', accountId: 'coach-9' }));
    mockForCoach.mockResolvedValue([
      { athlete_id: 'ath-1', full_name: 'Jordan Doe' },
      { athlete_id: 'ath-2', full_name: 'Riley Doe' },
    ]);
    mockCoachIds.mockResolvedValue(['ath-1']);
    mockSuggestions.mockImplementation(async (_organizationId: string, athleteIds: string[]) =>
      athleteIds.map((athleteId) => ({ ...SUGGESTION, athlete_id: athleteId })),
    );

    const payload = await (await GET(request())).json();

    expect(mockSuggestions).toHaveBeenCalledWith('org-1', ['ath-1']);
    expect(payload.items.map((item: { athlete_id: string }) => item.athlete_id)).toEqual(['ath-1']);
    expect(JSON.stringify(payload)).not.toContain('ath-2');
    expect(JSON.stringify(payload)).not.toContain('Riley Doe');
  });

  test('an organization admin reads the whole roster', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
    mockForOrg.mockResolvedValue([{ athlete_id: 'ath-1', full_name: 'Jordan Doe' }]);
    mockSuggestions.mockResolvedValue([]);

    const payload = await (await GET(request())).json();

    expect(mockForOrg).toHaveBeenCalledWith('org-1');
    expect(payload.items).toEqual([]);
  });
});
