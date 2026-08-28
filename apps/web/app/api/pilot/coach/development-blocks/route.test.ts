import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { assertActorCanAccessAthlete, athleteIdsForCoach } from '@/src/server/pilot/access';
import {
  createDevelopmentBlock,
  getDevelopmentBlock,
  listDevelopmentBlocks,
  listDevelopmentBlocksForAthlete,
  updateDevelopmentBlock,
} from '@/src/server/pilot/athleteDevelopmentBlocks';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/*
 * The coach API over the development-block foundation.
 *
 * athleteDevelopmentBlocks.ts deliberately stopped short of this: its header
 * says "exactly which staff roles may author a block is an owner decision that
 * this slice does not make", and it enforces only the organization-membership
 * floor. This route answers that question with the platform's existing answer
 * rather than a new one -- assertActorCanAccessAthlete -- and these tests are
 * about whether it actually asks.
 *
 * The relationship rules themselves (coach of record UNION active coverage,
 * organization boundary, soft-deleted athletes) are proven against real
 * Postgres in athleteIdsForCoach.pg.test.ts, coachCoverage.pg.test.ts and
 * coachAuthorizedRoster.pg.test.ts. Nothing here re-asserts them with mocks.
 * What is asserted here is that no path reaches a block without the gate, and
 * that the gate is applied to the athlete the STORED row names.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return {
    ...actual,
    assertActorCanAccessAthlete: jest.fn(),
    athleteIdsForCoach: jest.fn(),
  };
});

jest.mock('@/src/server/pilot/athleteDevelopmentBlocks', () => {
  const actual = jest.requireActual('@/src/server/pilot/athleteDevelopmentBlocks');
  return {
    ...actual,
    createDevelopmentBlock: jest.fn(),
    getDevelopmentBlock: jest.fn(),
    listDevelopmentBlocks: jest.fn(),
    listDevelopmentBlocksForAthlete: jest.fn(),
    updateDevelopmentBlock: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAssertAccess = assertActorCanAccessAthlete as jest.Mock;
const mockCoachIds = athleteIdsForCoach as jest.Mock;
const mockCreate = createDevelopmentBlock as jest.Mock;
const mockGet = getDevelopmentBlock as jest.Mock;
const mockListAll = listDevelopmentBlocks as jest.Mock;
const mockListForAthlete = listDevelopmentBlocksForAthlete as jest.Mock;
const mockUpdate = updateDevelopmentBlock as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-coach-a',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function block(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    block_id: 'blk-1',
    athlete_id: 'ath-1',
    title: 'Winter technical block',
    training_emphasis: 'Guard recovery off the jab.',
    starts_on: '2026-09-01',
    ends_on: '2026-10-13',
    status: 'draft',
    created_by_account_id: 'acct-coach-a',
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/coach/development-blocks', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function patchRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/coach/development-blocks', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

const getRequest = (query = '') =>
  new NextRequest(`http://localhost/api/pilot/coach/development-blocks${query}`);

/** What assertActorCanAccessAthlete does for an athlete outside the actor's reach. */
function refuseAthlete(athleteId: string) {
  mockAssertAccess.mockImplementation(async (_actor: unknown, id: string) => {
    if (id === athleteId) {
      throw new Error('Forbidden: coach not assigned to athlete');
    }
  });
}

describe('who may reach this route at all', () => {
  test.each(['coach', 'organization_admin', 'admin'])('the %s role is served', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));
    mockListAll.mockResolvedValue([]);
    mockCoachIds.mockResolvedValue([]);

    expect((await GET(getRequest())).status).toBe(200);
  });

  test.each(['athlete', 'parent', 'board', 'platform_owner', 'staff', 'volunteer'])(
    'the %s role is refused on every verb',
    async (role) => {
      // platform_owner and board are absent for the reasons
      // assertActorCanAccessAthlete itself gives: the first is refused
      // organization-private athlete records by default, the second reads
      // aggregates only. A block is a named plan about one child.
      mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

      expect((await GET(getRequest())).status).toBe(403);
      expect((await POST(postRequest({ athlete_id: 'ath-1' }))).status).toBe(403);
      expect((await PATCH(patchRequest({ block_id: 'blk-1' }))).status).toBe(403);

      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockListAll).not.toHaveBeenCalled();
    },
  );
});

describe('reading blocks', () => {
  test("a coach reading one athlete passes the access gate before the read", async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
    mockListForAthlete.mockResolvedValue([block()]);

    const payload = await (await GET(getRequest('?athlete_id=ath-1'))).json();

    expect(mockAssertAccess).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-coach-a' }), 'ath-1');
    expect(payload.blocks).toHaveLength(1);
  });

  test('an athlete the coach cannot reach is refused, and never read', async () => {
    // Not an empty list: a caller must not be able to tell "no blocks" from
    // "not your athlete", or the route becomes a roster oracle.
    mockRequirePrincipal.mockResolvedValue(principal());
    refuseAthlete('ath-2');

    const response = await GET(getRequest('?athlete_id=ath-2'));

    expect(response.status).toBe(403);
    expect(mockListForAthlete).not.toHaveBeenCalled();
  });

  test("the landing list is filtered to the coach's own athletes", async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockListAll.mockResolvedValue([
      block({ block_id: 'blk-1', athlete_id: 'ath-1' }),
      block({ block_id: 'blk-2', athlete_id: 'ath-2' }),
    ]);
    mockCoachIds.mockResolvedValue(['ath-1']);

    const payload = await (await GET(getRequest())).json();

    expect(payload.blocks.map((row: { block_id: string }) => row.block_id)).toEqual(['blk-1']);
    expect(JSON.stringify(payload)).not.toContain('ath-2');
  });

  test('an organization admin reads the organization, without the coach filter', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
    mockListAll.mockResolvedValue([
      block({ block_id: 'blk-1', athlete_id: 'ath-1' }),
      block({ block_id: 'blk-2', athlete_id: 'ath-2' }),
    ]);

    const payload = await (await GET(getRequest())).json();

    expect(mockCoachIds).not.toHaveBeenCalled();
    expect(payload.blocks).toHaveLength(2);
  });

  test('the read is scoped to the principal\'s organization, never a supplied one', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-mine' }));
    mockAssertAccess.mockResolvedValue(undefined);
    mockListForAthlete.mockResolvedValue([]);

    await GET(getRequest('?athlete_id=ath-1&organization_id=org-theirs'));

    expect(mockListForAthlete).toHaveBeenCalledWith('org-mine', 'ath-1');
  });
});

describe('creating a block', () => {
  test('a coach creates one for an athlete they may reach, attributed to them', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue(block());

    const response = await POST(postRequest({
      athlete_id: 'ath-1',
      title: 'Winter technical block',
      training_emphasis: 'Guard recovery off the jab.',
      starts_on: '2026-09-01',
      ends_on: '2026-10-13',
      status: 'draft',
    }));

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      athleteId: 'ath-1',
      createdByAccountId: 'acct-coach-a',
      title: 'Winter technical block',
      trainingEmphasis: 'Guard recovery off the jab.',
      startsOn: '2026-09-01',
      endsOn: '2026-10-13',
      status: 'draft',
    }));
  });

  test('the creator is the session, never a value the caller sent', async () => {
    // Attribution is a fact about who did this. A client-supplied author is a
    // forged signature on a plan about a child.
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-really-me' }));
    mockAssertAccess.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue(block());

    await POST(postRequest({
      athlete_id: 'ath-1',
      title: 'T',
      training_emphasis: 'E',
      starts_on: '2026-09-01',
      ends_on: '2026-09-30',
      created_by_account_id: 'acct-somebody-else',
    }));

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ createdByAccountId: 'acct-really-me' }),
    );
  });

  test('the organization is the session, never a value the caller sent', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-mine' }));
    mockAssertAccess.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue(block());

    await POST(postRequest({
      athlete_id: 'ath-1',
      organization_id: 'org-theirs',
      title: 'T',
      training_emphasis: 'E',
      starts_on: '2026-09-01',
      ends_on: '2026-09-30',
    }));

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-mine' }));
  });

  test('an athlete outside the coach\'s reach is refused, and nothing is written', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    refuseAthlete('ath-2');

    const response = await POST(postRequest({
      athlete_id: 'ath-2',
      title: 'T',
      training_emphasis: 'E',
      starts_on: '2026-09-01',
      ends_on: '2026-09-30',
    }));

    expect(response.status).toBe(403);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('a missing athlete_id is refused before any access check', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await POST(postRequest({ title: 'T' }));

    expect(response.status).toBe(400);
    expect(mockAssertAccess).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('an unknown status is refused rather than stored', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);

    const response = await POST(postRequest({
      athlete_id: 'ath-1',
      title: 'T',
      training_emphasis: 'E',
      starts_on: '2026-09-01',
      ends_on: '2026-09-30',
      status: 'peaking',
    }));

    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('an athlete that vanished between the gate and the write is a 404, not a silent success', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
    mockCreate.mockResolvedValue(null);

    const response = await POST(postRequest({
      athlete_id: 'ath-1',
      title: 'T',
      training_emphasis: 'E',
      starts_on: '2026-09-01',
      ends_on: '2026-09-30',
    }));

    expect(response.status).toBe(404);
    expect((await response.json()).ok).toBeUndefined();
  });

  test('a shape the foundation refuses is reported, not swallowed', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
    mockCreate.mockRejectedValue(
      Object.assign(new Error('A development block cannot end before it begins.'), {
        name: 'ValidationError',
      }),
    );

    const response = await POST(postRequest({
      athlete_id: 'ath-1',
      title: 'T',
      training_emphasis: 'E',
      starts_on: '2026-10-01',
      ends_on: '2026-09-01',
    }));

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe('editing a block', () => {
  test('the access gate is applied to the athlete the STORED block names', async () => {
    /* The defect this shape exists to prevent: authorizing against an
       athlete_id the CALLER sent would let a patch carrying a reachable
       athlete's id write to a block about a child the caller cannot reach. */
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGet.mockResolvedValue(block({ athlete_id: 'ath-not-mine' }));
    refuseAthlete('ath-not-mine');

    const response = await PATCH(patchRequest({
      block_id: 'blk-1',
      athlete_id: 'ath-1',
      title: 'Renamed by somebody else',
    }));

    expect(response.status).toBe(403);
    expect(mockAssertAccess).toHaveBeenCalledWith(expect.anything(), 'ath-not-mine');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('an athlete_id in the patch body never reaches the update', async () => {
    // The other half of the same guard: even authorized, a block does not
    // change which child it is about.
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGet.mockResolvedValue(block());
    mockAssertAccess.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(block({ title: 'Renamed' }));

    await PATCH(patchRequest({ block_id: 'blk-1', athlete_id: 'ath-9', title: 'Renamed' }));

    const patch = mockUpdate.mock.calls[0][2];
    expect(patch).not.toHaveProperty('athleteId');
    expect(patch).not.toHaveProperty('athlete_id');
  });

  test('created_by is never patchable', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGet.mockResolvedValue(block());
    mockAssertAccess.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(block());

    await PATCH(patchRequest({
      block_id: 'blk-1',
      created_by_account_id: 'acct-somebody-else',
      title: 'Renamed',
    }));

    const patch = mockUpdate.mock.calls[0][2];
    expect(JSON.stringify(patch)).not.toContain('acct-somebody-else');
  });

  test('only the named fields are sent, so an omitted one is not blanked', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGet.mockResolvedValue(block());
    mockAssertAccess.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(block({ ends_on: '2026-11-01' }));

    await PATCH(patchRequest({ block_id: 'blk-1', ends_on: '2026-11-01' }));

    expect(mockUpdate).toHaveBeenCalledWith('org-1', 'blk-1', { endsOn: '2026-11-01' });
  });

  test('a block in another organization is not found, and is not distinguishable from a missing one', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-mine' }));
    mockGet.mockResolvedValue(null);

    const response = await PATCH(patchRequest({ block_id: 'blk-elsewhere', title: 'T' }));

    expect(response.status).toBe(404);
    expect(mockGet).toHaveBeenCalledWith('org-mine', 'blk-elsewhere');
    expect(mockAssertAccess).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('a missing block_id is refused before anything is read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await PATCH(patchRequest({ title: 'T' }));

    expect(response.status).toBe(400);
    expect(mockGet).not.toHaveBeenCalled();
  });

  test('an unknown status is refused rather than stored', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGet.mockResolvedValue(block());
    mockAssertAccess.mockResolvedValue(undefined);

    const response = await PATCH(patchRequest({ block_id: 'blk-1', status: 'tapering' }));

    expect(response.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test.each(['draft', 'active', 'completed', 'cancelled'])(
    'the %s status is accepted, and none of them advances itself',
    async (status) => {
      // A human decides. Nothing in this route reads a date and moves a block.
      mockRequirePrincipal.mockResolvedValue(principal());
      mockGet.mockResolvedValue(block());
      mockAssertAccess.mockResolvedValue(undefined);
      mockUpdate.mockResolvedValue(block({ status }));

      const response = await PATCH(patchRequest({ block_id: 'blk-1', status }));

      expect(response.status).toBe(200);
      expect(mockUpdate).toHaveBeenCalledWith('org-1', 'blk-1', { status });
    },
  );
});

describe('nothing computed reaches the caller', () => {
  test('the response carries the stored row and no derived training science', async () => {
    /* The order this slice serves forbids workload scores, readiness-adjusted
       volume, ACWR, fatigue or injury-risk scores, taper percentages and
       automatic periodization classification. The way to keep them out is to
       return the row. */
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
    mockListForAthlete.mockResolvedValue([block()]);

    const payload = await (await GET(getRequest('?athlete_id=ath-1'))).json();

    expect(Object.keys(payload.blocks[0]).sort()).toEqual([
      'athlete_id', 'block_id', 'created_at', 'created_by_account_id', 'ends_on',
      'organization_id', 'starts_on', 'status', 'title', 'training_emphasis', 'updated_at',
    ]);
  });
});
