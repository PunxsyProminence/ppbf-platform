import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getDrillWithDetail, listDrillLibrary } from '@/src/server/pilot/drillLibraryV3';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';

// CHARACTERIZATION, NOT ENDORSEMENT.
//
// This route had no test file at all. That is the reason this one exists: a
// change to who may read the v3 drill library would have failed nothing.
//
// What it pins is what the route DOES today, which is not the same as what it
// SHOULD do. Two sibling surfaces serving the same class of content disagree,
// each with a written rationale, and neither cites the other:
//
//   /api/pilot/drills          gates to seven roles, excluding board and
//                              platform_owner -- "the board is excluded because
//                              its access is organization-level aggregates, and
//                              the platform owner because a gym's drills are
//                              the gym's"
//   /api/pilot/drill-library   no role gate -- "any authenticated role can
//   (this route)               browse the library; it carries no athlete data"
//
// Which posture is right is an OPEN OWNER DECISION. ORGANIZATION_ROLE_MODEL.md
// constrains athlete-scoped data and is silent on gym-wide non-athlete coaching
// content, so it does not settle it. Nothing here should be read as settling it
// either -- when it is decided, the expectations below change with the code,
// and that is the point. Today a change would be silent; after this it is
// visible.
//
// The route reads pilot.drill_library, a different table from
// /api/pilot/drills' pilot.drills. Two generations of drill library, same
// content class.

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/drillLibraryV3', () => {
  const actual = jest.requireActual('@/src/server/pilot/drillLibraryV3');
  return { ...actual, listDrillLibrary: jest.fn(), getDrillWithDetail: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listDrillLibrary as jest.Mock;
const mockDetail = getDrillWithDetail as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(role: PilotRole): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as PilotPrincipal;
}

const getRequest = (query = '') =>
  new NextRequest(`http://localhost/api/pilot/drill-library${query ? `?${query}` : ''}`);

/**
 * Every role in the vocabulary, listed so a NEW role cannot be added to
 * PilotRole and quietly inherit this route's posture without someone deciding
 * that it should.
 */
const ALL_ROLES: PilotRole[] = [
  'platform_owner',
  'organization_admin',
  'admin',
  'coach',
  'athlete',
  'parent',
  'board',
  'volunteer',
  'staff',
];

describe('who may read the v3 drill library today', () => {
  it.each(ALL_ROLES)('%s is admitted', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockList.mockResolvedValue([]);

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('org-1', expect.any(Object));
  });

  it('admits board and platform_owner, which the sibling drills route refuses', () => {
    // Stated as its own case rather than left implicit in the sweep above,
    // because these two are the entire disagreement. If the owner rules that
    // this route should match /api/pilot/drills, this is the case that has to
    // change, and it should be impossible to miss.
    expect(ALL_ROLES).toContain('board');
    expect(ALL_ROLES).toContain('platform_owner');
  });

  it('the route holds no role gate at all -- admission is by authentication alone', () => {
    // The mechanism, not just the outcome. A future gate that admitted all nine
    // roles explicitly would satisfy every case above while being a materially
    // different thing: a decision, rather than the absence of one.
    const source = fs.readFileSync(path.join(__dirname, 'route.ts'), 'utf8');
    expect(source).not.toMatch(/requireRole/);
    expect(source).toMatch(/requirePrincipal/);
  });
});

describe('the reads it performs are organization-scoped', () => {
  it('lists only the caller organization, with filters passed through', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockList.mockResolvedValue([{ drill_id: 'drl-1' }]);

    const response = await GET(getRequest('discipline=boxing&category=defense'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ drills: [{ drill_id: 'drl-1' }] });
    expect(mockList).toHaveBeenCalledWith('org-1', {
      discipline: 'boxing',
      category: 'defense',
      difficulty: undefined,
      skillId: undefined,
    });
  });

  it('reads one drill detail against the caller organization', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('athlete'));
    mockDetail.mockResolvedValue({ drill_id: 'drl-9' });

    const response = await GET(getRequest('drill_id=drl-9'));

    expect(response.status).toBe(200);
    expect(mockDetail).toHaveBeenCalledWith('org-1', 'drl-9');
  });

  it('ignores an organization supplied in the query, on both read paths', async () => {
    // The assertion above is not enough on its own, and mutation testing is how
    // that surfaced: changing the route to
    // `searchParams.get('org') ?? principal.organizationId` left every other
    // case green, because none of them sent an `org` parameter. A test that
    // only ever passes benign input cannot tell "never reads input" apart from
    // "was not asked to".
    //
    // This matters more than the role question this file otherwise records:
    // whoever may read, they may only read their own gym.
    const hostile = 'org=org-victim&organization_id=org-victim&organizationId=org-victim';

    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockDetail.mockResolvedValue({ drill_id: 'drl-9' });
    await GET(getRequest(`drill_id=drl-9&${hostile}`));
    expect(mockDetail).toHaveBeenCalledWith('org-1', 'drl-9');

    mockList.mockResolvedValue([]);
    await GET(getRequest(hostile));
    expect(mockList).toHaveBeenCalledWith('org-1', expect.any(Object));
  });

  it('returns 404 for a drill the caller organization does not hold', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockDetail.mockResolvedValue(null);

    const response = await GET(getRequest('drill_id=drl-elsewhere'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'DRILL_NOT_FOUND' });
  });

  it('refuses an unauthenticated caller', async () => {
    mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));

    const response = await GET(getRequest());

    expect(response.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });
});
