import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { countUnlinkedAssignments, listAthleteFamilyDrills } from '@/src/server/pilot/skillProgressionOrder';
import { FAMILY_MEMBER_CODES, SKILL_FAMILY_IDS } from '@/src/server/pilot/skillFamilies';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/*
  Own record only, read-only. The assertions are about the ways that can go
  wrong: another subject reached through a query parameter, a role other than
  the athlete served, the access gate skipped, and an unmapped family sent as
  an empty list (which would tell a kid they have done nothing there).
*/

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/skillProgressionOrder', () => {
  const actual = jest.requireActual('@/src/server/pilot/skillProgressionOrder');
  return { ...actual, listAthleteFamilyDrills: jest.fn(), countUnlinkedAssignments: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAssertAccess = assertActorCanAccessAthlete as jest.Mock;
const mockList = listAthleteFamilyDrills as jest.Mock;
const mockUnlinked = countUnlinkedAssignments as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-athlete-a',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = (query = '') => new NextRequest(`http://localhost/api/pilot/athlete/skill-progression${query}`);

const DRILL = {
  assignment_id: 'asg-1',
  drill_display_name: 'Guard reset off the jab',
  status: 'in_progress',
  assigned_at: '2026-10-01T00:00:00.000Z',
};

describe('who may reach this route', () => {
  test.each(['coach', 'organization_admin', 'admin', 'parent', 'platform_owner'])(
    'the %s role is refused, and nothing is read',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

      const response = await GET(getRequest('?athlete_id=ath-1'));

      expect(response.status).toBe(403);
      expect(mockList).not.toHaveBeenCalled();
      expect(mockUnlinked).not.toHaveBeenCalled();
    },
  );

  test('an athlete account with no athlete record is refused, and nothing is read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ athleteId: null }));

    const response = await GET(getRequest());

    expect(response.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('the subject is the session athlete; an athlete_id parameter is never read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
    mockList.mockResolvedValue([]);
    mockUnlinked.mockResolvedValue(0);

    await GET(getRequest('?athlete_id=someone-else'));

    expect(mockAssertAccess).toHaveBeenCalledWith(expect.anything(), 'ath-1');
    for (const call of mockList.mock.calls) expect(call[1]).toBe('ath-1');
    expect(mockUnlinked).toHaveBeenCalledWith('org-1', 'ath-1');
  });

  test('a refused access gate stops the read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    const { ForbiddenError } = jest.requireActual('@/src/server/pilot/errors');
    mockAssertAccess.mockRejectedValue(new ForbiddenError('no'));

    const response = await GET(getRequest());

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockUnlinked).not.toHaveBeenCalled();
  });
});

describe('what the athlete receives', () => {
  beforeEach(() => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
  });

  test('every family is present; mapped families carry rows, the rest say not_mapped', async () => {
    mockList.mockResolvedValue([DRILL]);
    mockUnlinked.mockResolvedValue(2);

    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Object.keys(body.records).sort()).toEqual([...SKILL_FAMILY_IDS].sort());
    for (const id of SKILL_FAMILY_IDS) {
      if (FAMILY_MEMBER_CODES[id]) {
        expect(body.records[id]).toEqual({ state: 'mapped', items: [DRILL] });
      } else {
        expect(body.records[id]).toEqual({ state: 'not_mapped' });
      }
    }
    expect(body.records['SKILL-01'].state).toBe('mapped');
    expect(body.unlinked).toBe(2);
    expect(body.steps[0].families[0].familyId).toBe('SKILL-01');
  });

  test('the database is asked only for families that have a crosswalk, with that crosswalk', async () => {
    mockList.mockResolvedValue([]);
    mockUnlinked.mockResolvedValue(0);

    await GET(getRequest());

    const mapped = SKILL_FAMILY_IDS.filter((id) => FAMILY_MEMBER_CODES[id]);
    expect(mockList).toHaveBeenCalledTimes(mapped.length);
    expect(mockList).toHaveBeenCalledWith('org-1', 'ath-1', FAMILY_MEMBER_CODES['SKILL-01']);
  });

  test('a mapped family with no drills is an empty list, which here truly means none', async () => {
    mockList.mockResolvedValue([]);
    mockUnlinked.mockResolvedValue(0);

    const body = await (await GET(getRequest())).json();

    expect(body.records['SKILL-01']).toEqual({ state: 'mapped', items: [] });
  });
});
