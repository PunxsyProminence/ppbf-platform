import fs from 'node:fs';
import path from 'node:path';

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
   * THE POSTURE THIS ROUTE HOLDS, and the decision that put it here.
   *
   * These cases were written against the previous posture and asserted it:
   * the route called `requirePrincipal` and not `requireRole`, its own comment
   * said "any authenticated role can browse", and every authenticated role
   * reached it -- including one that three sibling coaching-content surfaces
   * refused. The block said so, said the disagreement was an open owner
   * question, and said the cases existed so that whichever way it was answered,
   * the answer would arrive as a deliberate change to this file.
   *
   * It has been answered, and this is that change.
   *
   * The 2026-08-27 decision gated /api/pilot/drills, /api/pilot/drill-library
   * and /api/pilot/coach/cue-library on COACHING_CONTENT_READER_ROLES. What
   * was left open was whether those three routes were the decision's subject
   * or merely its occasion. On 2026-08-28 the owner was asked exactly that --
   * does the policy govern the content class, or only the routes it named --
   * and answered the content class. A session script is that class: it is the
   * gym's own teaching plan, it is coaching craft, and it carries no athlete
   * data. So the assertions below are inverted rather than deleted, and
   * `board` now receives 403 where it received 200.
   *
   * `board` is still what supplies the difference. It is the one PilotRole
   * COACHING_CONTENT_READER_ROLES excludes -- nine roles in the union in
   * contracts.ts, eight in the policy -- so a board principal is the single
   * observation that separates "ungated" from "gated like the siblings". That
   * partition is owned and asserted by `coachingContentAccess.test.ts` and
   * `drill-library/route.test.ts`, which read the union out of contracts.ts;
   * what this file checks is narrower and stated as such below: that board is
   * outside the policy, and that it is refused here.
   *
   * `workout-templates/route.test.ts` carries the same block, named the same
   * way, for the same reason.
   */
  it('a coach may browse the catalogue', async () => {
    // The preserved half of the decision, and NOT a tripwire on its own: coach
    // is inside COACHING_CONTENT_READER_ROLES, so this case reads the same
    // before and after the gate. It is here because a gate that refused the
    // board by refusing everybody would satisfy the case below.
    mockList.mockResolvedValue([{ script_id: 'scr-1', name: 'Friday sparring' }]);

    expect((await get('http://localhost/api/pilot/session-scripts')).status).toBe(200);
  });

  it('a board principal, the role the coaching-content policy excludes, is refused', async () => {
    // The decisive case. It read 200 until 2026-08-28 and reads 403 now; it
    // fails the moment the gate is taken off this route again.
    expect(COACHING_CONTENT_READER_ROLES).not.toContain(COACHING_CONTENT_OUTSIDER);

    mockRequirePrincipal.mockResolvedValue(principal({ role: COACHING_CONTENT_OUTSIDER }));
    mockList.mockResolvedValue([{ script_id: 'scr-1', name: 'Friday sparring' }]);

    const response = await get('http://localhost/api/pilot/session-scripts');

    expect(response.status).toBe(403);
    // A refusal that has already read the gym's teaching plans is not a
    // refusal. The old case asserted the body for the mirror-image reason --
    // that a 200 carrying an empty list would be a narrowing reported as an
    // empty catalogue.
    expect(mockList).not.toHaveBeenCalled();
  });

  it('the same holds on the detail branch, which a gate placed after the branch would miss', async () => {
    // Two reads sit behind one `requirePrincipal` here, and the case above
    // only observes one of them. Measured while this block pinned the ungated
    // posture: a `requireRole` written inside the `if (scriptId)` branch
    // instead of after `requirePrincipal` left the list case GREEN and only
    // this one red. The gate is above both branches, so both are covered, and
    // this case is what says so.
    mockRequirePrincipal.mockResolvedValue(principal({ role: COACHING_CONTENT_OUTSIDER }));
    mockDetail.mockResolvedValue({ script_id: 'scr-1', blocks: [], renderings: [] });

    const response = await get('http://localhost/api/pilot/session-scripts?script_id=scr-1');

    expect(response.status).toBe(403);
    expect(mockDetail).not.toHaveBeenCalled();
  });

  it('refuses the board BEFORE the query is parsed, so the gate is not reachable around', async () => {
    // WHY THE ORDERING IS LOAD-BEARING, and it was measured on a sibling
    // rather than reasoned about: on /api/pilot/coach/cue-library, with the
    // gate below the focus_type check, a board caller sending
    // `focus_type=telepathic` received a 400 instead of a 403 -- a different
    // answer to "may I read this?" depending on how well-formed the request
    // was, and a disclosure that the parameter exists to a caller who may not
    // read the resource at all.
    //
    // This route validates no parameter, so no input can produce that 400 here
    // today and no runtime case can tell the two orderings apart. The runtime
    // half below is therefore honest about being weak, and the position check
    // is what actually bites: it goes red if the gate is moved below the
    // parse, and it is what keeps the ordering true on the day somebody adds
    // the first validating parse -- which is when the defect can arrive.
    mockRequirePrincipal.mockResolvedValue(principal({ role: COACHING_CONTENT_OUTSIDER }));

    const response = await get(
      'http://localhost/api/pilot/session-scripts?day_of_week=neverday&authoring_state=%%%',
    );

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();

    const source = fs.readFileSync(path.resolve(__dirname, './route.ts'), 'utf8');
    const gate = source.indexOf('requireRole(principal, [...COACHING_CONTENT_READER_ROLES]);');
    const parse = source.indexOf('new URL(request.url)');

    expect(gate).toBeGreaterThan(-1);
    expect(parse).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(parse);
  });
});
