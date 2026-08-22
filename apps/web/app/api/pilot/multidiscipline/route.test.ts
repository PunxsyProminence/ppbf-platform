import { NextRequest } from 'next/server';

import { GET } from './route';
import {
  getCurrentDisciplineParticipation,
  listDisciplines,
  listGrapplingExposure,
} from '@/src/server/pilot/multidiscipline';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
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

jest.mock('@/src/server/pilot/multidiscipline', () => {
  const actual = jest.requireActual('@/src/server/pilot/multidiscipline');
  return {
    ...actual,
    listDisciplines: jest.fn(),
    listGrapplingExposure: jest.fn(),
    getCurrentDisciplineParticipation: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockDisciplines = listDisciplines as jest.Mock;
const mockExposure = listGrapplingExposure as jest.Mock;
const mockParticipation = getCurrentDisciplineParticipation as jest.Mock;

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
  mockDisciplines.mockResolvedValue([]);
  mockExposure.mockResolvedValue([]);
  mockParticipation.mockResolvedValue([]);
});

describe('GET /api/pilot/multidiscipline -- the disciplines', () => {
  it('returns the discipline list', async () => {
    mockDisciplines.mockResolvedValue([{ discipline: 'boxing' }]);

    const response = await get('http://localhost/api/pilot/multidiscipline');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ disciplines: [{ discipline: 'boxing' }] });
  });

  it('hides retired disciplines by default', async () => {
    await get('http://localhost/api/pilot/multidiscipline');

    expect(mockDisciplines).toHaveBeenCalledWith('org-1', { activeOnly: true });
  });

  it('drops the active filter entirely when include_inactive is true', async () => {
    // undefined, not false: the module reads `$2::boolean is null` as "no
    // filter", whereas false would ask for the retired ones ONLY.
    await get('http://localhost/api/pilot/multidiscipline?include_inactive=true');

    expect(mockDisciplines).toHaveBeenCalledWith('org-1', { activeOnly: undefined });
  });

  it('treats any other include_inactive value as not opting in', async () => {
    for (const raw of ['false', '1', 'yes', '']) {
      mockDisciplines.mockClear();
      await get(`http://localhost/api/pilot/multidiscipline?include_inactive=${raw}`);
      expect(mockDisciplines).toHaveBeenCalledWith('org-1', { activeOnly: true });
    }
  });

  it('lets any authenticated role read which disciplines the gym runs', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent' }));

    expect((await get('http://localhost/api/pilot/multidiscipline')).status).toBe(200);
  });

  it('scopes to the principal organization', async () => {
    await get('http://localhost/api/pilot/multidiscipline?organization_id=other');

    expect(mockDisciplines).toHaveBeenCalledWith('org-1', expect.anything());
  });
});

describe('GET /api/pilot/multidiscipline -- one athlete', () => {
  it('returns exposure history and current participation together', async () => {
    mockExposure.mockResolvedValue([{ exposure_id: 'exp-1' }]);
    mockParticipation.mockResolvedValue([{ discipline: 'grappling', participation_level: 'technique_only' }]);

    const response = await get('http://localhost/api/pilot/multidiscipline?athlete_id=ath-1');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      exposure: [{ exposure_id: 'exp-1' }],
      participation: [{ discipline: 'grappling', participation_level: 'technique_only' }],
    });
  });

  it('refuses a parent, who may read the disciplines but not exposure history', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent' }));

    const response = await get('http://localhost/api/pilot/multidiscipline?athlete_id=ath-1');

    expect(response.status).toBe(403);
    expect(mockExposure).not.toHaveBeenCalled();
  });

  it('refuses an athlete reading any athlete_id, including their own', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', athleteId: 'ath-1' }));

    const response = await get('http://localhost/api/pilot/multidiscipline?athlete_id=ath-1');

    expect(response.status).toBe(403);
    expect(mockExposure).not.toHaveBeenCalled();
  });

  it('refuses a coach who holds no relationship to that athlete', async () => {
    // The role gate passes -- this caller IS a coach. Who they may read a
    // choke and submission history about is a separate question, and one the
    // organization boundary alone does not answer.
    mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

    const response = await get('http://localhost/api/pilot/multidiscipline?athlete_id=ath-other');

    expect(response.status).toBe(403);
    expect(mockExposure).not.toHaveBeenCalled();
    expect(mockParticipation).not.toHaveBeenCalled();
  });

  it('checks athlete access with the principal and the requested athlete', async () => {
    await get('http://localhost/api/pilot/multidiscipline?athlete_id=ath-1');

    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'coach-1' }), 'ath-1');
  });

  it('does not fall through to the discipline list when athlete_id is given', async () => {
    await get('http://localhost/api/pilot/multidiscipline?athlete_id=ath-1');

    expect(mockDisciplines).not.toHaveBeenCalled();
  });

  it('returns empty history for an athlete with none, not an error', async () => {
    const response = await get('http://localhost/api/pilot/multidiscipline?athlete_id=ath-new');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ exposure: [], participation: [] });
  });

  it('surfaces an unauthenticated caller as an error', async () => {
    mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));

    expect((await get('http://localhost/api/pilot/multidiscipline')).status).toBe(401);
  });
});

describe('GET /api/pilot/multidiscipline -- no write path', () => {
  it('exposes no method other than GET', async () => {
    // Recording a completed choke is a safeguarding event; the form for it is
    // the owner's call, so no write verb is published here by accident.
    const route = await import('./route');

    expect(Object.keys(route).filter((k) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(k))).toEqual([]);
  });
});
