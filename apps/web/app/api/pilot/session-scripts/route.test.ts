import { NextRequest } from 'next/server';

import { GET } from './route';
import { COACHING_CONTENT_READER_ROLES } from '@/src/server/pilot/coachingContentAccess';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getSessionScriptWithDetail, listSessionScripts } from '@/src/server/pilot/sessionScripts';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/sessionScripts', () => {
  const actual = jest.requireActual('@/src/server/pilot/sessionScripts');
  return { ...actual, listSessionScripts: jest.fn(), getSessionScriptWithDetail: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listSessionScripts as jest.Mock;
const mockDetail = getSessionScriptWithDetail as jest.Mock;

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

/**
 * The role that sits OUTSIDE COACHING_CONTENT_READER_ROLES, named here so the
 * `who may browse` cases below say why they picked it rather than looking
 * like an arbitrary choice of role. The block's comment carries the reasoning;
 * the assertion that it really is outside the policy sits in the case itself,
 * so this is a label rather than a claim.
 *
 * Same name, same shape as `workout-templates/route.test.ts`: the two routes
 * hold one posture and their tests are meant to be read together.
 */
const COACHING_CONTENT_OUTSIDER: PilotRole = 'board';

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockList.mockResolvedValue([]);
  mockDetail.mockResolvedValue(null);
});

describe('GET /api/pilot/session-scripts', () => {
  it('lists scripts for the caller organization', async () => {
    mockList.mockResolvedValue([{ script_id: 'scr-1', name: 'Friday sparring' }]);

    const response = await get('http://localhost/api/pilot/session-scripts');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      scripts: [{ script_id: 'scr-1', name: 'Friday sparring' }],
    });
  });

  it('scopes the query to the principal organization, never a caller-supplied one', async () => {
    await get('http://localhost/api/pilot/session-scripts?organization_id=other-org');

    expect(mockList).toHaveBeenCalledWith('org-1', expect.anything());
  });

  it('passes every browse filter through to the module', async () => {
    await get(
      'http://localhost/api/pilot/session-scripts'
        + '?discipline=boxing&phase=taper&day_of_week=friday&authoring_state=in_use',
    );

    expect(mockList).toHaveBeenCalledWith('org-1', {
      discipline: 'boxing',
      phase: 'taper',
      dayOfWeek: 'friday',
      authoringState: 'in_use',
      includeRetired: false,
    });
  });

  it('leaves absent filters undefined rather than sending empty strings', async () => {
    await get('http://localhost/api/pilot/session-scripts');

    expect(mockList).toHaveBeenCalledWith('org-1', {
      discipline: undefined,
      phase: undefined,
      dayOfWeek: undefined,
      authoringState: undefined,
      includeRetired: false,
    });
  });

  it('only includes retired scripts when include_retired is exactly true', async () => {
    await get('http://localhost/api/pilot/session-scripts?include_retired=true');
    expect(mockList.mock.calls[0][1].includeRetired).toBe(true);

    // Anything else is not an opt-in. A truthy-string check here would make
    // `include_retired=false` surface retired plans as live ones.
    for (const raw of ['false', '1', 'yes', '']) {
      mockList.mockClear();
      await get(`http://localhost/api/pilot/session-scripts?include_retired=${raw}`);
      expect(mockList.mock.calls[0][1].includeRetired).toBe(false);
    }
  });

  it('returns one script with its blocks when script_id is given', async () => {
    mockDetail.mockResolvedValue({ script_id: 'scr-1', blocks: [{ block_id: 'blk-1' }], renderings: [] });

    const response = await get('http://localhost/api/pilot/session-scripts?script_id=scr-1');

    expect(mockDetail).toHaveBeenCalledWith('org-1', 'scr-1');
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      script: { script_id: 'scr-1', blocks: [{ block_id: 'blk-1' }], renderings: [] },
    });
  });

  it('404s an unknown script rather than returning an empty envelope', async () => {
    const response = await get('http://localhost/api/pilot/session-scripts?script_id=nope');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'SESSION_SCRIPT_NOT_FOUND' });
  });

  it('does not fall through to the list when script_id is present but unknown', async () => {
    await get('http://localhost/api/pilot/session-scripts?script_id=nope');

    expect(mockList).not.toHaveBeenCalled();
  });

  it('surfaces an unauthenticated caller as an error, not an empty list', async () => {
    // The real requirePrincipal throws a plain Error('Unauthorized'); jsonError
    // maps it by message. Rejecting with any other shape here would prove only
    // that the fallback 500 branch works.
    mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));

    const response = await get('http://localhost/api/pilot/session-scripts');

    expect(response.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('who may browse', () => {
  /**
   * THE POSTURE THIS ROUTE HOLDS TODAY, pinned rather than endorsed.
   *
   * The route calls `requirePrincipal` and NOT `requireRole`: its own comment
   * says "Any authenticated role can browse: a script is the gym's own
   * teaching plan and carries no athlete data." So every authenticated role
   * reaches it, including one that three sibling coaching-content surfaces
   * refuse.
   *
   * Whether that is right is an OPEN OWNER QUESTION and it has not been put
   * to him. /api/pilot/drills, /api/pilot/drill-library and
   * /api/pilot/coach/cue-library were gated on COACHING_CONTENT_READER_ROLES
   * by an owner decision on 2026-08-27; this route and its workout-templates
   * sibling were not in that decision. Nothing here argues either way. These
   * cases exist so that whichever way it is eventually answered, the answer
   * arrives as a deliberate change to this file rather than silently.
   *
   * Until now this file asserted nothing at all about which role may browse.
   * Its only auth case was the unauthenticated one in the describe above, so
   * "who may read the gym's teaching plans" was recorded nowhere. Measured
   * against 27ac8538, before this block existed: adding
   * `requireRole(principal, [...COACHING_CONTENT_READER_ROLES])` immediately
   * after `requirePrincipal` in route.ts left all 9 cases in this file and
   * all 11 in `workout-templates/route.test.ts` green -- 20/20, no failures.
   *
   * `board` is what supplies the difference. It is the one PilotRole that
   * COACHING_CONTENT_READER_ROLES excludes -- nine roles in the union in
   * contracts.ts, eight in the policy -- so a board principal reaching this
   * route is the single observation that separates "ungated" from "gated like
   * the siblings". That partition is owned and asserted by
   * `coachingContentAccess.test.ts` and `drill-library/route.test.ts`, which
   * read the union out of contracts.ts; what this file checks is narrower and
   * stated as such below: that board is outside the policy, and that it
   * reaches this route today.
   *
   * `workout-templates/route.test.ts` carries the same block, named the same
   * way, for the same reason.
   */
  it('a coach may browse the catalogue', async () => {
    // True, and NOT a tripwire on its own: coach is inside
    // COACHING_CONTENT_READER_ROLES, so this case survives the gate. It is
    // kept because it is the ordinary reader the route was written for, and
    // the board case below is what makes the block bite.
    mockList.mockResolvedValue([{ script_id: 'scr-1', name: 'Friday sparring' }]);

    expect((await get('http://localhost/api/pilot/session-scripts')).status).toBe(200);
  });

  it('a board principal, the role the coaching-content policy excludes, may browse today', async () => {
    // The decisive case. It fails the moment anyone gates this route on
    // COACHING_CONTENT_READER_ROLES, which is exactly the change the block
    // above says must not happen quietly.
    expect(COACHING_CONTENT_READER_ROLES).not.toContain(COACHING_CONTENT_OUTSIDER);

    mockRequirePrincipal.mockResolvedValue(principal({ role: COACHING_CONTENT_OUTSIDER }));
    mockList.mockResolvedValue([{ script_id: 'scr-1', name: 'Friday sparring' }]);

    const response = await get('http://localhost/api/pilot/session-scripts');

    // Status and body both: a gate that returned 200 with an empty list would
    // be a narrowing this route reported as a catalogue with nothing in it.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      scripts: [{ script_id: 'scr-1', name: 'Friday sparring' }],
    });
    expect(mockList).toHaveBeenCalledWith('org-1', expect.any(Object));
  });

  it('the same holds on the detail branch, which a gate placed there alone would narrow', async () => {
    // Two reads sit behind one `requirePrincipal` here, and the case above
    // only observes one of them. Measured: a `requireRole` written inside the
    // `if (scriptId)` branch instead of after `requirePrincipal` left the
    // list case above GREEN and only this one red. So the two are not
    // standing in for each other.
    mockRequirePrincipal.mockResolvedValue(principal({ role: COACHING_CONTENT_OUTSIDER }));
    mockDetail.mockResolvedValue({ script_id: 'scr-1', blocks: [], renderings: [] });

    const response = await get('http://localhost/api/pilot/session-scripts?script_id=scr-1');

    expect(response.status).toBe(200);
    expect(mockDetail).toHaveBeenCalledWith('org-1', 'scr-1');
  });
});
