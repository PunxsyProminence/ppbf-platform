import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getDrillWithDetail, listDrillLibrary } from '@/src/server/pilot/drillLibraryV3';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';

// The question this file used to record is now answered.
//
// It was written as a characterization test because three surfaces serving one
// class of content held three postures: /api/pilot/drills gated to seven roles
// excluding board and platform_owner, while this route and the cue library
// gated to nothing at all -- each with a written rationale, none citing the
// others. The header here said which posture was right was an OPEN OWNER
// DECISION, and that when it was decided "the expectations below change with
// the code, and that is the point."
//
// It was decided on 2026-08-27. The board is DENIED: oversight and aggregate
// governance, not operational coaching content. The platform owner is ALLOWED,
// organization-scoped -- reaching this gym's drills through the organization
// its own principal carries, and no other. The seven organization member roles
// are preserved exactly. coachingContentAccess.ts holds the decision; these
// cases are what makes it true of this route.
//
// The route reads pilot.drill_library, a different table from
// /api/pilot/drills' pilot.drills. Two generations of drill library, same
// content class -- which is why one answer now covers both.

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
 * Every role in the vocabulary, partitioned. Listed in full rather than
 * derived from COACHING_CONTENT_READER_ROLES: a test that asks the policy what
 * the policy says cannot notice the policy changing. A tenth role added to
 * PilotRole fails the exhaustiveness case below rather than quietly landing on
 * whichever side of the gate the implementation happens to put it.
 */
const ADMITTED_ROLES: PilotRole[] = [
  'platform_owner',
  'organization_admin',
  'admin',
  'coach',
  'athlete',
  'parent',
  'volunteer',
  'staff',
];

const DENIED_ROLES: PilotRole[] = ['board'];

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

describe('who may read the v3 drill library', () => {
  it('accounts for every role in the vocabulary, so a new one cannot default in', () => {
    expect([...ADMITTED_ROLES, ...DENIED_ROLES].sort()).toEqual([...ALL_ROLES].sort());
  });

  it.each(ADMITTED_ROLES)('%s is admitted', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockList.mockResolvedValue([]);

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('org-1', expect.any(Object));
  });

  it.each(DENIED_ROLES)('%s is refused, and the read never runs', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockList.mockResolvedValue([]);

    const response = await GET(getRequest());

    expect(response.status).toBe(403);
    // The status alone would pass if the gate ran AFTER the query. A refusal
    // that has already read the library is not a refusal.
    expect(mockList).not.toHaveBeenCalled();
  });

  it('refuses the board on the detail path too, not only the list', async () => {
    // Two reads live behind this one gate and only one of them is a list. A
    // gate placed inside the list branch would satisfy every case above.
    mockRequirePrincipal.mockResolvedValue(principal('board'));
    mockDetail.mockResolvedValue({ drill_id: 'drl-9' });

    const response = await GET(getRequest('drill_id=drl-9'));

    expect(response.status).toBe(403);
    expect(mockDetail).not.toHaveBeenCalled();
  });

  it('admits the platform owner, which this route already did, and refuses the board, which it did not', () => {
    // Stated as its own case because these two ARE the change. Before the
    // decision this route admitted both; /api/pilot/drills refused both. The
    // outcome is neither of those postures, so a reader who assumes it simply
    // adopted the sibling's list would be wrong.
    expect(ADMITTED_ROLES).toContain('platform_owner');
    expect(DENIED_ROLES).toContain('board');
  });

  it('gates on the shared policy rather than a list of its own', () => {
    // The mechanism, not just the outcome. A local literal that happened to
    // hold the same eight roles would satisfy every case above while
    // reintroducing the exact defect the decision resolved: one question,
    // answered separately in each file, free to drift.
    const source = fs.readFileSync(path.join(__dirname, 'route.ts'), 'utf8');
    expect(source).toMatch(/requireRole\(principal, \[\.\.\.COACHING_CONTENT_READER_ROLES\]\)/);
    expect(source).toMatch(
      /import \{ COACHING_CONTENT_READER_ROLES \} from '@\/src\/server\/pilot\/coachingContentAccess'/,
    );
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
