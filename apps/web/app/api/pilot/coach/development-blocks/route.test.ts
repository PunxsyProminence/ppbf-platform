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
import {
  listDevelopmentBlockTargetOptions,
  resolveDevelopmentBlockTarget,
  setDevelopmentBlockTarget,
} from '@/src/server/pilot/athleteDevelopmentBlockTargets';
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
 *
 * WHAT MOVED, 2026-08-28. This route used to hand the module an
 * organizationId string and then re-derive a coach's reach itself, filtering
 * listDevelopmentBlocks' output through athleteIdsForCoach -- because the
 * module read the whole gym and the narrowing had to happen somewhere. Reads
 * are now athlete-scoped in the data layer (owner decision: "Admin, Coach,
 * Athlete, Guardian"), so every function here takes the principal and the
 * re-derivation is gone rather than duplicated.
 *
 * That changes what these mocked tests CAN prove, and the change is stated
 * rather than papered over: with the module mocked, this file can no longer
 * watch a block get filtered out, because nothing in this file filters any
 * more. What it asserts instead is DELEGATION -- that the identity handed
 * down is the session's and never the caller's, and that the route returns
 * what the module answered without widening it. The filtering itself is
 * proven against real rows in athleteDevelopmentBlocks.pg.test.ts, where an
 * unassigned coach of the same gym reads an empty list.
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

jest.mock('@/src/server/pilot/athleteDevelopmentBlockTargets', () => ({
  resolveDevelopmentBlockTarget: jest.fn(async () => null),
  listDevelopmentBlockTargetOptions: jest.fn(async () => []),
  setDevelopmentBlockTarget: jest.fn(),
}));

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
const mockResolveTarget = resolveDevelopmentBlockTarget as jest.Mock;
const mockTargetOptions = listDevelopmentBlockTargetOptions as jest.Mock;
const mockSetTarget = setDevelopmentBlockTarget as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

beforeEach(() => {
  // The ordinary case: a block with no target. Tests that care set their own.
  mockResolveTarget.mockResolvedValue(null);
  mockTargetOptions.mockResolvedValue([]);
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
    target_competition_id: null,
    target_wrestling_event_id: null,
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

  test('the landing list delegates its scope to the data layer, and does not re-derive one', async () => {
    /* The route hands down the PRINCIPAL and returns what comes back. It no
       longer calls athleteIdsForCoach: listDevelopmentBlocks filters through
       accessibleAthleteIds, so a second copy of the rule here would be a
       second thing to forget to update -- and, worse, a filter that could
       silently disagree with the one the module applies.

       The corresponding "an unassigned coach sees nothing" proof lives in
       athleteDevelopmentBlocks.pg.test.ts against real rows. */
    mockRequirePrincipal.mockResolvedValue(principal());
    mockListAll.mockResolvedValue([block({ block_id: 'blk-1', athlete_id: 'ath-1' })]);

    const payload = await (await GET(getRequest())).json();

    expect(mockListAll).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'acct-coach-a', organizationId: 'org-1', role: 'coach' }),
    );
    expect(mockCoachIds).not.toHaveBeenCalled();
    expect(payload.blocks.map((row: { block_id: string }) => row.block_id)).toEqual(['blk-1']);
  });

  test('an organization admin is handed down as an admin, not flattened to a coach', async () => {
    // The module decides what an admin reaches. What this route owes is an
    // honest identity: the role travels with it, unaltered.
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
    mockListAll.mockResolvedValue([
      block({ block_id: 'blk-1', athlete_id: 'ath-1' }),
      block({ block_id: 'blk-2', athlete_id: 'ath-2' }),
    ]);

    const payload = await (await GET(getRequest())).json();

    expect(mockListAll).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'organization_admin', organizationId: 'org-1' }),
    );
    expect(mockCoachIds).not.toHaveBeenCalled();
    // Returned as given: the route does not narrow what the module allowed,
    // any more than it widens it.
    expect(payload.blocks).toHaveLength(2);
  });

  test('the read is scoped to the principal\'s organization, never a supplied one', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-mine' }));
    mockAssertAccess.mockResolvedValue(undefined);
    mockListForAthlete.mockResolvedValue([]);

    await GET(getRequest('?athlete_id=ath-1&organization_id=org-theirs'));

    expect(mockListForAthlete).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-mine' }),
      'ath-1',
    );
    // The supplied organization reaches the module nowhere, in any argument.
    expect(JSON.stringify(mockListForAthlete.mock.calls)).not.toContain('org-theirs');
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
      actor: expect.objectContaining({ organizationId: 'org-1', accountId: 'acct-coach-a' }),
      athleteId: 'ath-1',
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

    /* Attribution now rides the actor rather than a separate field, which is
       the stronger shape: there is no createdByAccountId parameter left for a
       caller-supplied author to be written into. The module reads
       actor.accountId, and the actor is the session. */
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ actor: expect.objectContaining({ accountId: 'acct-really-me' }) }),
    );
    expect(JSON.stringify(mockCreate.mock.calls)).not.toContain('acct-somebody-else');
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

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ actor: expect.objectContaining({ organizationId: 'org-mine' }) }),
    );
    expect(JSON.stringify(mockCreate.mock.calls)).not.toContain('org-theirs');
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
    expect(mockSetTarget).not.toHaveBeenCalled();
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

    expect(mockUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', accountId: 'acct-coach-a' }),
      'blk-1',
      { endsOn: '2026-11-01' },
    );
  });

  test('a block in another organization is not found, and is not distinguishable from a missing one', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-mine' }));
    mockGet.mockResolvedValue(null);

    const response = await PATCH(patchRequest({ block_id: 'blk-elsewhere', title: 'T' }));

    expect(response.status).toBe(404);
    expect(mockGet).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-mine' }),
      'blk-elsewhere',
    );
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
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-1' }),
        'blk-1',
        { status },
      );
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
    mockResolveTarget.mockResolvedValue(null);

    const payload = await (await GET(getRequest('?athlete_id=ath-1'))).json();

    /* The exact key set, so a computed field cannot be added without this
       failing. `target_competition_id`, `target_wrestling_event_id` and the
       resolved `target` joined this list when the competition target shipped:
       a stored id and a name/date/status read back off a skeletal fixture
       table are not derived training science, and adding them here is a
       deliberate widening rather than a hole. Anything ELSE appearing --
       a load, a percentage, a taper, an adherence figure -- still reds. */
    expect(Object.keys(payload.blocks[0]).sort()).toEqual([
      'athlete_id', 'block_id', 'created_at', 'created_by_account_id', 'ends_on',
      'organization_id', 'starts_on', 'status', 'target', 'target_competition_id',
      'target_wrestling_event_id', 'title', 'training_emphasis', 'updated_at',
    ]);
  });
});

/*
 * THE COMPETITION / EVENT TARGET.
 *
 * Open Question 2 of module 036's engine-unlock proposal, answered (a): a
 * block may optionally name the event it is preparing for, "as a target date
 * only (name and date, nothing else), leaving both competition tables exactly
 * as skeletal as they are today."
 *
 * So these hold three things: that naming a target goes through the same
 * athlete gate as every other write to a block, that a target is only ever a
 * name and a date on the way out, and that clearing one is distinguishable
 * from not mentioning it.
 */
function competitionTarget(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'competition',
    id: 'comp-1',
    name: 'Keystone Open',
    date: '2026-11-14',
    location: 'Altoona, PA',
    sanctioning_body: 'USA Boxing',
    status: 'planned',
    ...overrides,
  };
}

describe('naming what a block is preparing for', () => {
  test('a target is set through the same athlete gate as every other block write', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGet.mockResolvedValue(block({ athlete_id: 'ath-1' }));
    mockAssertAccess.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(block({ target_competition_id: 'comp-1' }));

    const response = await PATCH(patchRequest({
      block_id: 'blk-1',
      target: { kind: 'competition', id: 'comp-1' },
    }));

    expect(response.status).toBe(200);
    expect(mockAssertAccess).toHaveBeenCalledWith(expect.anything(), 'ath-1');
    /* The first argument is the principal now, not an organization id: #762
       moved the athlete-access gate into the data layer, so the actor travels
       with the write. What this still pins is what it always pinned -- the
       organization reaching the module is the SESSION's, never one the caller
       sent. objectContaining, so a later field on the principal does not turn
       this into a failure about nothing. */
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), 'blk-1', { target: { kind: 'competition', id: 'comp-1' } });
  });

  test('fields and target go in ONE write, so neither can land without the other', async () => {
    /* They were two calls until review on #771. A target that failed its
       foreign key left the field changes committed and the caller was told
       the request failed -- then retried, against a row that had moved. */
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGet.mockResolvedValue(block());
    mockAssertAccess.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(block({ title: 'Renamed', target_competition_id: 'comp-1' }));

    await PATCH(patchRequest({
      block_id: 'blk-1',
      title: 'Renamed',
      target: { kind: 'competition', id: 'comp-1' },
    }));

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), 'blk-1', {
      title: 'Renamed',
      target: { kind: 'competition', id: 'comp-1' },
    });
    expect(mockSetTarget).not.toHaveBeenCalled();
  });

  test('a malformed target is refused BEFORE the field write, not after it', async () => {
    // The exact reported defect: good fields plus a bad target used to commit
    // the fields and then 400.
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGet.mockResolvedValue(block());
    mockAssertAccess.mockResolvedValue(undefined);

    const response = await PATCH(patchRequest({
      block_id: 'blk-1',
      title: 'Renamed',
      target: { kind: 'olympics', id: 'x' },
    }));

    expect(response.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('a coach who cannot reach the block\'s athlete cannot retarget it', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGet.mockResolvedValue(block({ athlete_id: 'ath-not-mine' }));
    refuseAthlete('ath-not-mine');

    const response = await PATCH(patchRequest({
      block_id: 'blk-1',
      target: { kind: 'competition', id: 'comp-1' },
    }));

    expect(response.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('a wrestling event is an equally valid target', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGet.mockResolvedValue(block());
    mockAssertAccess.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(block({ target_wrestling_event_id: 'evt-1' }));

    await PATCH(patchRequest({
      block_id: 'blk-1',
      target: { kind: 'wrestling_event', id: 'evt-1' },
    }));

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), 'blk-1', { target: { kind: 'wrestling_event', id: 'evt-1' } });
  });

  test('null clears the target, and is not confused with not mentioning it', async () => {
    // The reason `target` is one key rather than two nullable columns in the
    // patch: null has to be able to mean "clear this".
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGet.mockResolvedValue(block({ target_competition_id: 'comp-1' }));
    mockAssertAccess.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(block());

    await PATCH(patchRequest({ block_id: 'blk-1', target: null }));

    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), 'blk-1', { target: { kind: 'none' } });
  });

  test('a patch that never mentions a target leaves it alone', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGet.mockResolvedValue(block({ target_competition_id: 'comp-1' }));
    mockAssertAccess.mockResolvedValue(undefined);
    mockUpdate.mockResolvedValue(block({ title: 'Renamed', target_competition_id: 'comp-1' }));

    await PATCH(patchRequest({ block_id: 'blk-1', title: 'Renamed' }));

    // No `target` key on the patch at all -- the block keeps what it names.
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), 'blk-1', { title: 'Renamed' });
  });

  test.each([
    ['a bare string', 'comp-1'],
    ['an unknown kind', { kind: 'olympics', id: 'x' }],
    ['a kind with no id', { kind: 'competition' }],
    ['a blank id', { kind: 'competition', id: '   ' }],
    ['an array', [{ kind: 'competition', id: 'comp-1' }]],
  ])('%s is refused rather than quietly becoming "no target"', async (_label, value) => {
    // Coercing a malformed target to "none" would read to a coach as having
    // cleared something they were trying to set.
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGet.mockResolvedValue(block());
    mockAssertAccess.mockResolvedValue(undefined);

    const response = await PATCH(patchRequest({ block_id: 'blk-1', target: value }));

    expect(response.status).toBe(400);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('a resolved target rides back with the block, as a name and a date', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
    mockListForAthlete.mockResolvedValue([block({ target_competition_id: 'comp-1' })]);
    mockResolveTarget.mockResolvedValue(competitionTarget());

    const payload = await (await GET(getRequest('?athlete_id=ath-1'))).json();

    expect(payload.blocks[0].target).toEqual(competitionTarget());
  });

  test('a block with no target reads as null, not as a missing key', async () => {
    // A reader must be able to tell "no target" from "this response shape
    // does not carry targets".
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
    mockListForAthlete.mockResolvedValue([block()]);
    mockResolveTarget.mockResolvedValue(null);

    const payload = await (await GET(getRequest('?athlete_id=ath-1'))).json();

    expect(payload.blocks[0]).toHaveProperty('target', null);
  });

  test('a cancelled event stays linked and stays marked cancelled', async () => {
    // The coach WAS preparing for it. Dropping the link would leave them
    // unable to tell a cancelled target from one that was never chosen.
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockResolvedValue(undefined);
    mockListForAthlete.mockResolvedValue([block({ target_competition_id: 'comp-1' })]);
    mockResolveTarget.mockResolvedValue(competitionTarget({ status: 'cancelled' }));

    const payload = await (await GET(getRequest('?athlete_id=ath-1'))).json();

    expect(payload.blocks[0].target.status).toBe('cancelled');
    expect(payload.blocks[0].target_competition_id).toBe('comp-1');
  });
});

describe('the target picker', () => {
  test('it lists the organization\'s competitions and events', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockTargetOptions.mockResolvedValue([competitionTarget()]);

    const payload = await (await GET(getRequest('?targets=options'))).json();

    expect(mockTargetOptions).toHaveBeenCalledWith('org-1');
    expect(payload.options).toEqual([competitionTarget()]);
  });

  test('it is scoped to the principal\'s organization, never a supplied one', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-mine' }));
    mockTargetOptions.mockResolvedValue([]);

    await GET(getRequest('?targets=options&organization_id=org-theirs'));

    expect(mockTargetOptions).toHaveBeenCalledWith('org-mine');
    expect(mockTargetOptions).not.toHaveBeenCalledWith('org-theirs');
  });

  test('it reads no athlete data and applies no athlete gate', async () => {
    /* A competition is a fixture, not a record about a child. Gating the
       picker on an athlete would be theatre -- and would need an athlete id
       this branch has no business asking for. Which BLOCK a target may be
       attached to is the athlete question, and PATCH answers it. */
    mockRequirePrincipal.mockResolvedValue(principal());
    mockTargetOptions.mockResolvedValue([competitionTarget()]);

    await GET(getRequest('?targets=options'));

    expect(mockAssertAccess).not.toHaveBeenCalled();
    expect(mockListForAthlete).not.toHaveBeenCalled();
    expect(mockCoachIds).not.toHaveBeenCalled();
  });

  test.each(['athlete', 'parent', 'board', 'platform_owner'])(
    'the %s role cannot read the picker either',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

      expect((await GET(getRequest('?targets=options'))).status).toBe(403);
      expect(mockTargetOptions).not.toHaveBeenCalled();
    },
  );
});
