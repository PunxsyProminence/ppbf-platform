import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import {
  getAthleteCohortReport,
  listCohortDefinitions,
  listCompetenceLevels,
} from '@/src/server/pilot/competenceCohorts';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { setAthleteCompetence } from '@/src/server/pilot/competenceWrite';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
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

jest.mock('@/src/server/pilot/competenceWrite', () => {
  const actual = jest.requireActual('@/src/server/pilot/competenceWrite');
  return { ...actual, setAthleteCompetence: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockLevels = listCompetenceLevels as jest.Mock;
const mockCohorts = listCohortDefinitions as jest.Mock;
const mockReport = getAthleteCohortReport as jest.Mock;
const mockSet = setAthleteCompetence as jest.Mock;

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
  // The default caller holds access for the athlete they ask about. Every
  // 200 below therefore asserts "a coach WITH access", not "a coach".
  mockAccess.mockResolvedValue(undefined);
  mockLevels.mockResolvedValue([]);
  mockCohorts.mockResolvedValue([]);
  mockReport.mockResolvedValue(null);
  mockSet.mockResolvedValue({ changed: true, competence_id: 'comp_1', domain: 'footwork', level_key: 'adapting', previous_level_key: null });
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

  it('allows an organization_admin, which requireRole does not alias to admin', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
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

  it('refuses a coach who holds no relationship to that athlete', async () => {
    // The role gate passes -- this caller IS a coach. What it must not decide
    // is WHICH athlete, and age_years here is derived from the dob that
    // entities.ts redacts from this same coach's roster listing.
    mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

    const response = await get('http://localhost/api/pilot/competence-cohorts?athlete_id=ath-other');

    expect(response.status).toBe(403);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it('checks athlete access with the principal and the requested athlete', async () => {
    await get('http://localhost/api/pilot/competence-cohorts?athlete_id=ath-1');

    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'coach-1' }), 'ath-1');
  });

  it('404s an unknown athlete rather than returning an empty report', async () => {
    // Reachable only once access is granted: a coach asking about an athlete
    // id that does not exist is refused by the gate first (403, existence not
    // disclosed), exactly as on training-attempts and passbook.
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

describe('POST /api/pilot/competence-cohorts -- a coach sets a level', () => {
  function post(body: unknown) {
    return POST(new NextRequest('http://localhost/api/pilot/competence-cohorts', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }));
  }

  const valid = { athlete_id: 'ath-1', domain: 'footwork', level_key: 'adapting', evidence_note: ' moved well ' };

  it('writes the level and returns the refreshed report', async () => {
    mockReport.mockResolvedValue({ athlete_id: 'ath-1', fits: [] });

    const response = await post(valid);

    expect(response.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'coach-1', organizationId: 'org-1' }),
      { athleteId: 'ath-1', domain: 'footwork', levelKey: 'adapting', evidenceNote: 'moved well' },
    );
    expect(mockReport).toHaveBeenCalledWith('org-1', 'ath-1');
    const payload = await response.json();
    expect(payload.result.changed).toBe(true);
    expect(payload.report).toEqual({ athlete_id: 'ath-1', fits: [] });
  });

  it.each(['admin', 'organization_admin'] as const)('allows %s', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));

    expect((await post(valid)).status).toBe(200);
  });

  it.each(['parent', 'athlete', 'platform_owner', 'board', 'staff', 'volunteer'] as const)(
    'refuses %s before reading the body or writing',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role, athleteId: role === 'athlete' ? 'ath-1' : null }));

      const response = await post(valid);

      expect(response.status).toBe(403);
      expect(mockSet).not.toHaveBeenCalled();
    },
  );

  it('ignores an organization_id in the body: the write is scoped to the principal', async () => {
    await post({ ...valid, organization_id: 'org-other' });

    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), expect.anything());
    expect(mockSet.mock.calls[0][1]).not.toHaveProperty('organization_id');
  });

  it('surfaces the access guard refusing a coach with no relationship as 403', async () => {
    mockSet.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

    const response = await post(valid);

    expect(response.status).toBe(403);
    expect(mockReport).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-object body', 'not json'],
    ['a missing athlete_id', { domain: 'footwork', level_key: 'adapting' }],
    ['an unknown domain', { athlete_id: 'ath-1', domain: 'grappling', level_key: 'adapting' }],
    ['a missing level_key', { athlete_id: 'ath-1', domain: 'footwork' }],
    ['a non-text note', { athlete_id: 'ath-1', domain: 'footwork', level_key: 'adapting', evidence_note: 5 }],
    ['an over-long note', { athlete_id: 'ath-1', domain: 'footwork', level_key: 'adapting', evidence_note: 'x'.repeat(501) }],
  ])('400s %s without writing', async (_label, body) => {
    const response = await post(body);

    expect(response.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('surfaces an unauthenticated caller as 401', async () => {
    mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));

    expect((await post(valid)).status).toBe(401);
    expect(mockSet).not.toHaveBeenCalled();
  });
});
