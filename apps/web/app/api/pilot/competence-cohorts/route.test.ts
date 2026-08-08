import { NextRequest } from 'next/server';

import { GET } from './route';
import {
  getAthleteCohortReport,
  listCohortDefinitions,
  listCompetenceLevels,
} from '@/src/server/pilot/competenceCohorts';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/competenceCohorts', () => {
  const actual = jest.requireActual('@/src/server/pilot/competenceCohorts');
  return {
    ...actual,
    listCompetenceLevels: jest.fn(),
    listCohortDefinitions: jest.fn(),
    getAthleteCohortReport: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockLevels = listCompetenceLevels as jest.Mock;
const mockCohorts = listCohortDefinitions as jest.Mock;
const mockReport = getAthleteCohortReport as jest.Mock;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function get(url: string) {
  return GET(new NextRequest(url));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockLevels.mockResolvedValue([]);
  mockCohorts.mockResolvedValue([]);
  mockReport.mockResolvedValue(null);
});

describe('GET /api/pilot/competence-cohorts -- the rules', () => {
  it('returns the ladder and the cohort rules together', async () => {
    mockLevels.mockResolvedValue([{ level_key: 'exploring', ordinal: 1 }]);
    mockCohorts.mockResolvedValue([{ cohort_id: 'coh-1' }]);

    const response = await get('http://localhost/api/pilot/competence-cohorts');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      levels: [{ level_key: 'exploring', ordinal: 1 }],
      cohorts: [{ cohort_id: 'coh-1' }],
    });
  });

  it('lets any authenticated role read the rules, including a parent', async () => {
    // Which rooms exist and what each requires is policy, not athlete data.
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent' }));

    const response = await get('http://localhost/api/pilot/competence-cohorts');

    expect(response.status).toBe(200);
  });

  it('scopes to the principal organization, never a caller-supplied one', async () => {
    await get('http://localhost/api/pilot/competence-cohorts?organization_id=other-org');

    expect(mockLevels).toHaveBeenCalledWith('org-1');
    expect(mockCohorts).toHaveBeenCalledWith('org-1', expect.anything());
  });

  it('only includes inactive cohorts when include_inactive is exactly true', async () => {
    await get('http://localhost/api/pilot/competence-cohorts?include_inactive=true');
    expect(mockCohorts.mock.calls[0][1].includeInactive).toBe(true);

    for (const raw of ['false', '1', 'yes', '']) {
      mockCohorts.mockClear();
      await get(`http://localhost/api/pilot/competence-cohorts?include_inactive=${raw}`);
      expect(mockCohorts.mock.calls[0][1].includeInactive).toBe(false);
    }
  });
});

describe('GET /api/pilot/competence-cohorts -- one athlete', () => {
  it('returns the report for a coach', async () => {
    mockReport.mockResolvedValue({ athlete_id: 'ath-1', fits: [] });

    const response = await get('http://localhost/api/pilot/competence-cohorts?athlete_id=ath-1');

    expect(mockReport).toHaveBeenCalledWith('org-1', 'ath-1', { discipline: undefined });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ report: { athlete_id: 'ath-1', fits: [] } });
  });

  it('allows an admin as well as a coach', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'admin' }));
    mockReport.mockResolvedValue({ athlete_id: 'ath-1', fits: [] });

    expect((await get('http://localhost/api/pilot/competence-cohorts?athlete_id=ath-1')).status).toBe(200);
  });

  it('refuses a parent, who may read the rules but not an athlete assessment', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent' }));

    const response = await get('http://localhost/api/pilot/competence-cohorts?athlete_id=ath-1');

    expect(response.status).toBe(403);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('refuses an athlete reading any athlete_id, including their own', async () => {
    // Self-service would need a route that checks the principal's own
    // athlete_id; silently allowing it here would also allow reading others.
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', athleteId: 'ath-1' }));

    const response = await get('http://localhost/api/pilot/competence-cohorts?athlete_id=ath-1');

    expect(response.status).toBe(403);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('404s an unknown athlete rather than returning an empty report', async () => {
    const response = await get('http://localhost/api/pilot/competence-cohorts?athlete_id=nope');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'ATHLETE_NOT_FOUND' });
  });

  it('does not fall through to the rules list when athlete_id is unknown', async () => {
    await get('http://localhost/api/pilot/competence-cohorts?athlete_id=nope');

    expect(mockLevels).not.toHaveBeenCalled();
  });

  it('passes discipline through to the report', async () => {
    mockReport.mockResolvedValue({ athlete_id: 'ath-1', fits: [] });

    await get('http://localhost/api/pilot/competence-cohorts?athlete_id=ath-1&discipline=grappling');

    expect(mockReport).toHaveBeenCalledWith('org-1', 'ath-1', { discipline: 'grappling' });
  });

  it('surfaces an unauthenticated caller as an error, not an empty result', async () => {
    mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));

    const response = await get('http://localhost/api/pilot/competence-cohorts');

    expect(response.status).toBe(401);
    expect(mockLevels).not.toHaveBeenCalled();
  });
});
