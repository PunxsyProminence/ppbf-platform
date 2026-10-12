import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { GET } from './route';
import { COACHING_CONTENT_READER_ROLES } from '@/src/server/pilot/coachingContentAccess';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  getWorkoutTemplateWithItems,
  listWorkoutTemplates,
} from '@/src/server/pilot/workoutTemplates';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';

/**
 * THIS ROUTE HAD NO TEST. `workoutTemplates.pg.test.ts` proves the SQL against
 * a real database and `app/coach/workout-templates/page.test.tsx` proves what
 * the page does with a mocked `fetch` -- so both sides of this route were
 * covered and the route itself was not. That is the exact shape of the drill
 * library defect recorded in `app/api/pilot/drills/route.test.ts`: the route
 * sent one key, both clients read another, and every test on both sides stayed
 * green because nothing asserted what a caller actually receives.
 *
 * So the response BODY is pinned here, not only the arguments the route passes
 * down. `page.tsx` reads `templates` from the list and reads the detail
 * unwrapped; if either envelope changes, these fail rather than the gym
 * finding out.
 *
 * `jest.requireActual` is spread into the http mock deliberately: it keeps the
 * real `jsonError`, so the status mapping below is genuinely exercised instead
 * of being asserted against a stub of itself.
 */
jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/workoutTemplates', () => {
  const actual = jest.requireActual('@/src/server/pilot/workoutTemplates');
  return {
    ...actual,
    listWorkoutTemplates: jest.fn(),
    getWorkoutTemplateWithItems: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listWorkoutTemplates as jest.Mock;
const mockDetail = getWorkoutTemplateWithItems as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = (query = '') =>
  new NextRequest(`http://localhost/api/pilot/workout-templates${query ? `?${query}` : ''}`);

const TEMPLATE = { template_id: 'tpl-1', template_name: 'Monday technical' };

/**
 * The role that sits OUTSIDE COACHING_CONTENT_READER_ROLES, named here so the
 * `who may browse` cases below say why they picked it rather than looking
 * like an arbitrary choice of role. The block's comment carries the reasoning;
 * the assertion that it really is outside the policy sits in the case itself,
 * so this is a label rather than a claim.
 */
const COACHING_CONTENT_OUTSIDER: PilotRole = 'board';

describe('the list branch', () => {
  test('answers under the `templates` key the page actually reads', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockList.mockResolvedValue([TEMPLATE]);

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    // The drill-library lesson: assert what the caller receives, not only
    // what the route asked for.
    expect(await response.json()).toEqual({ templates: [TEMPLATE] });
  });

  test('passes the three filters through in the module casing', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockList.mockResolvedValue([]);

    await GET(getRequest('session_type=technical&difficulty=intermediate&age_band=13-15'));

    expect(mockList).toHaveBeenCalledWith('org-1', {
      sessionType: 'technical',
      difficulty: 'intermediate',
      ageBand: '13-15',
    });
  });

  test('an absent filter is undefined rather than null', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockList.mockResolvedValue([]);

    await GET(getRequest());

    expect(mockList).toHaveBeenCalledWith('org-1', {
      sessionType: undefined,
      difficulty: undefined,
      ageBand: undefined,
    });
  });
});

describe('the detail branch', () => {
  test('returns the template unwrapped, the shape the page reads', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockDetail.mockResolvedValue({ template: TEMPLATE, items: [{ item_id: 'item-1' }] });

    const response = await GET(getRequest('template_id=tpl-1'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      template: TEMPLATE,
      items: [{ item_id: 'item-1' }],
    });
    expect(mockDetail).toHaveBeenCalledWith('org-1', 'tpl-1');
    expect(mockList).not.toHaveBeenCalled();
  });

  test('a template that does not exist is a named 404, not an empty 200', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockDetail.mockResolvedValue(null);

    const response = await GET(getRequest('template_id=nope'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'WORKOUT_TEMPLATE_NOT_FOUND' });
  });
});

describe('the organization boundary', () => {
  /**
   * The route reads `principal.organizationId` and never touches a caller-
   * supplied one, which is what `organizationScope.convention.test.ts`
   * requires of every route. That test is a file-content scan, so it passes
   * here vacuously -- the route simply never mentions `organization_id`.
   * This asserts the behaviour instead of the absence.
   */
  test('a caller naming another gym is still read against their own', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-1' }));
    mockList.mockResolvedValue([]);

    await GET(getRequest('organization_id=org-2'));

    expect(mockList).toHaveBeenCalledWith('org-1', expect.anything());
  });

  test('the same holds on the detail branch', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-1' }));
    mockDetail.mockResolvedValue({ template: TEMPLATE, items: [] });

    await GET(getRequest('template_id=tpl-1&organization_id=org-2'));

    expect(mockDetail).toHaveBeenCalledWith('org-1', 'tpl-1');
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
   * and answered the content class. A workout template is that class: it is
   * the gym's own catalogue, it is coaching craft, and it carries no athlete
   * data. So the assertions below are inverted rather than deleted, and
   * `board` now receives 403 where it received 200.
   *
   * The block this replaced also recorded why an earlier version of it did not
   * work, and that lesson still applies to the athlete case below: a comment
   * claiming a tripwire ("a `requireRole` added later would tighten the route
   * silently. This pins the decision.") sat over an assertion compatible with
   * the change it named, because `athlete` is inside the policy. Only a role
   * outside the policy can tell the two postures apart.
   *
   * `board` is that role. It is the one PilotRole COACHING_CONTENT_READER_ROLES
   * excludes -- nine roles in the union in contracts.ts, eight in the policy --
   * so a board principal is the single observation that separates "ungated"
   * from "gated like the siblings". That partition is owned and asserted by
   * `coachingContentAccess.test.ts` and `drill-library/route.test.ts`, which
   * read the union out of contracts.ts; what this file checks is narrower and
   * stated as such below: that board is outside the policy, and that it is
   * refused here.
   *
   * `session-scripts/route.test.ts` carries the same block, named the same
   * way, for the same reason.
   */
  test('an athlete may browse the catalogue', async () => {
    // The preserved half of the decision, and NOT a tripwire on its own:
    // athlete is inside COACHING_CONTENT_READER_ROLES, so this case reads the
    // same before and after the gate. It is here because a gate that refused
    // the board by refusing everybody would satisfy the case below.
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockList.mockResolvedValue([TEMPLATE]);

    expect((await GET(getRequest())).status).toBe(200);
  });

  test('a board principal, the role the coaching-content policy excludes, is refused', async () => {
    // The decisive case. It read 200 until 2026-08-28 and reads 403 now; it
    // fails the moment the gate is taken off this route again.
    expect(COACHING_CONTENT_READER_ROLES).not.toContain(COACHING_CONTENT_OUTSIDER);

    mockRequirePrincipal.mockResolvedValue(principal({ role: COACHING_CONTENT_OUTSIDER }));
    mockList.mockResolvedValue([TEMPLATE]);

    const response = await GET(getRequest());

    expect(response.status).toBe(403);
    // A refusal that has already read the catalogue is not a refusal. The old
    // case asserted the body for the mirror-image reason -- that a 200
    // carrying an empty list would be a narrowing reported as an empty shelf.
    expect(mockList).not.toHaveBeenCalled();
  });

  test('the same holds on the detail branch, which a gate placed after the branch would miss', async () => {
    // Two reads sit behind one `requirePrincipal` here, and the case above
    // only observes one of them. Measured while this block pinned the ungated
    // posture: a `requireRole` written inside the `if (templateId)` branch
    // instead of after `requirePrincipal` left the list case GREEN and only
    // this one red. The gate is above both branches, so both are covered, and
    // this case is what says so.
    mockRequirePrincipal.mockResolvedValue(principal({ role: COACHING_CONTENT_OUTSIDER }));
    mockDetail.mockResolvedValue({ template: TEMPLATE, items: [] });

    const response = await GET(getRequest('template_id=tpl-1'));

    expect(response.status).toBe(403);
    expect(mockDetail).not.toHaveBeenCalled();
  });

  test('refuses the board BEFORE the query is parsed, so the gate is not reachable around', async () => {
    // WHY THE ORDERING IS LOAD-BEARING, and it was measured on a sibling
    // rather than reasoned about: on /api/pilot/coach/cue-library, with the
    // gate below the focus_type check, a board caller sending
    // `focus_type=telepathic` received a 400 instead of a 403 -- a different
    // answer to "may I read this?" depending on how well-formed the request
    // was, and a disclosure that the parameter exists to a caller who may not
    // read the resource at all.
    //
    // This route validates no parameter -- `difficulty` is cast to
    // WorkoutTemplateDifficulty and never checked -- so no input can produce
    // that 400 here today and no runtime case can tell the two orderings
    // apart. The runtime half below is therefore honest about being weak, and
    // the position check is what actually bites: it goes red if the gate is
    // moved below the parse, and it is what keeps the ordering true on the day
    // somebody adds the first validating parse, which is when the defect can
    // arrive.
    mockRequirePrincipal.mockResolvedValue(principal({ role: COACHING_CONTENT_OUTSIDER }));

    const response = await GET(getRequest('difficulty=telepathic&age_band=%%%'));

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();

    const source = fs.readFileSync(path.resolve(__dirname, './route.ts'), 'utf8');
    const gate = source.indexOf('requireRole(principal, [...COACHING_CONTENT_READER_ROLES]);');
    const parse = source.indexOf('new URL(request.url)');

    expect(gate).toBeGreaterThan(-1);
    expect(parse).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(parse);
  });

  test('an unauthenticated caller is refused and nothing is read', async () => {
    mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));

    expect((await GET(getRequest())).status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockDetail).not.toHaveBeenCalled();
  });

  test('a principal owing a PIN change is refused before any read', async () => {
    mockRequirePrincipal.mockRejectedValue(new Error('Forbidden: PIN change required'));

    expect((await GET(getRequest())).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
});

/**
 * Recorded rather than asserted as desirable: this route has NO 42P01
 * fallback, unlike access.ts, entities.ts, programMemberships.ts and the
 * other modules that tolerate a pre-migration database. On an environment
 * where the workout-templates migration has not been dispatched, the
 * undefined-table error propagates and the caller gets a 500.
 *
 * That is the current behaviour, and this test states it as such rather than
 * calling it correct. Whether the catalogue should degrade to an empty list
 * instead of a 500 is a product decision, not a test decision -- if it is
 * ever made, this test is the thing that has to change, which is exactly the
 * signal that it was a deliberate change.
 */
test('a missing table currently surfaces as a 500, with no fallback', async () => {
  mockRequirePrincipal.mockResolvedValue(principal());
  mockList.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }));

  expect((await GET(getRequest())).status).toBe(500);
});

/**
 * WHAT EACH READER RECEIVES (issue #1475, lane P2b).
 *
 * The gate admits eight roles and the route used to hand all eight the stored
 * rows: an athlete signed in to the live app received created_by_account_id (a
 * staff account id), created_by_role and coach_notes on every template. A
 * coach and an organization admin still get the stored rows; every other
 * admitted role gets the allow-list in workoutTemplateProjection.ts.
 *
 * The projection is NOT mocked: these cases read the response body the route
 * sends. The reduced shape is asserted as an exact key list, so a field added
 * to the allow-list by mistake fails here, and the marker values are searched
 * for in the response text, so a staff value arriving under any key fails too.
 */
describe('what each reader receives', () => {
  const MARK = 'STAFF-ONLY-MARK';

  const STORED_TEMPLATE = {
    organization_id: 'org-1',
    template_id: 'tpl-1',
    lineage_id: 'lin-1',
    version: 2,
    supersedes_template_id: 'tpl-0',
    superseded_at: null,
    name: 'Monday technical',
    session_type: 'technical',
    difficulty: 'intermediate',
    age_band: '13-15',
    duration_minutes: 60,
    intent: 'Jab defence',
    coach_notes: `${MARK} coach notes`,
    requires_coach_authorization: false,
    active: true,
    created_by_account_id: `${MARK}-author@example.test`,
    created_by_role: `${MARK}-role`,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-02T00:00:00.000Z',
  };

  const STORED_ITEM = {
    organization_id: 'org-1',
    item_id: 'itm-1',
    template_id: 'tpl-1',
    ordinal: 1,
    block: 'warmup',
    drill_id: 'drl-1',
    free_text_drill: null,
    scale_level: 'B',
    duration_minutes: 10,
    rep_count: null,
    contact_level: 'none',
    coach_note: `${MARK} item note`,
    created_at: '2026-10-01T00:00:00.000Z',
    head_drill_id: 'drl-1',
    head_drill_name: 'Catch and Return',
    uses_older_drill_version: false,
  };

  // A key beside `template` and `items`, as a later read may add one for the
  // coach's screen: a full-row reader gets it, nobody else does.
  const STORED_DETAIL = { template: STORED_TEMPLATE, items: [STORED_ITEM], coach_only_extra: `${MARK} extra` };

  const STAFF_FIELDS = ['created_by_account_id', 'created_by_role', 'coach_notes', 'coach_note'];

  const READER_TEMPLATE_KEYS = [
    'organization_id',
    'template_id',
    'lineage_id',
    'version',
    'supersedes_template_id',
    'superseded_at',
    'name',
    'session_type',
    'difficulty',
    'age_band',
    'duration_minutes',
    'intent',
    'requires_coach_authorization',
    'active',
    'created_at',
    'updated_at',
  ];

  const READER_ITEM_KEYS = [
    'organization_id',
    'item_id',
    'template_id',
    'ordinal',
    'block',
    'drill_id',
    'free_text_drill',
    'scale_level',
    'duration_minutes',
    'rep_count',
    'contact_level',
    'created_at',
    'head_drill_id',
    'head_drill_name',
    'uses_older_drill_version',
  ];

  // Listed in full, not derived from the projection's own predicate.
  const FULL_ROW_ROLES: PilotRole[] = ['coach', 'organization_admin', 'admin'];
  const REDUCED_ROW_ROLES: PilotRole[] = ['athlete', 'parent', 'volunteer', 'staff', 'platform_owner'];

  /** Every object key in a JSON value, at any depth. */
  function keysAtAnyDepth(value: unknown, found = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
      value.forEach((entry) => keysAtAnyDepth(entry, found));
    } else if (value !== null && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        found.add(key);
        keysAtAnyDepth(entry, found);
      }
    }
    return found;
  }

  beforeEach(() => {
    mockList.mockResolvedValue([STORED_TEMPLATE]);
    mockDetail.mockResolvedValue(STORED_DETAIL);
  });

  test('the two groups are exactly the roles the gate admits', () => {
    expect([...FULL_ROW_ROLES, ...REDUCED_ROW_ROLES].sort()).toEqual([...COACHING_CONTENT_READER_ROLES].sort());
  });

  describe.each(REDUCED_ROW_ROLES)('%s', (role) => {
    test('lists templates without the author, the author role or the coach notes', async () => {
      mockRequirePrincipal.mockResolvedValue(principal({ role }));

      const response = await GET(getRequest());

      expect(response.status).toBe(200);
      const text = await response.text();
      const body = JSON.parse(text) as { templates: Array<Record<string, unknown>> };
      expect(Object.keys(body)).toEqual(['templates']);
      expect(body.templates).toHaveLength(1);
      expect(Object.keys(body.templates[0])).toEqual(READER_TEMPLATE_KEYS);
      for (const field of STAFF_FIELDS) {
        expect(keysAtAnyDepth(body).has(field)).toBe(false);
      }
      expect(text).not.toContain(MARK);
      // What is left is the stored value, not a placeholder.
      expect(body.templates[0].name).toBe('Monday technical');
      expect(body.templates[0].intent).toBe('Jab defence');
    });

    test('reads one template without them, and its items without the coach note', async () => {
      mockRequirePrincipal.mockResolvedValue(principal({ role }));

      const response = await GET(getRequest('template_id=tpl-1'));

      expect(response.status).toBe(200);
      const text = await response.text();
      const body = JSON.parse(text) as { template: Record<string, unknown>; items: Array<Record<string, unknown>> };
      expect(Object.keys(body)).toEqual(['template', 'items']);
      expect(Object.keys(body.template)).toEqual(READER_TEMPLATE_KEYS);
      expect(body.items).toHaveLength(1);
      expect(Object.keys(body.items[0])).toEqual(READER_ITEM_KEYS);
      for (const field of STAFF_FIELDS) {
        expect(keysAtAnyDepth(body).has(field)).toBe(false);
      }
      expect(text).not.toContain(MARK);
      expect(body.items[0].head_drill_name).toBe('Catch and Return');
    });
  });

  describe.each(FULL_ROW_ROLES)('%s', (role) => {
    test('lists the stored rows exactly as before', async () => {
      mockRequirePrincipal.mockResolvedValue(principal({ role }));

      const response = await GET(getRequest());

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ templates: [STORED_TEMPLATE] });
    });

    test('reads the stored detail exactly as before, with every key the read returned', async () => {
      mockRequirePrincipal.mockResolvedValue(principal({ role }));

      const response = await GET(getRequest('template_id=tpl-1'));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toEqual(STORED_DETAIL);
      expect(Object.keys(body)).toEqual(['template', 'items', 'coach_only_extra']);
    });
  });

  test('a template that does not exist is the same 404 for a reduced reader', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete' }));
    mockDetail.mockResolvedValue(null);

    const response = await GET(getRequest('template_id=nope'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'WORKOUT_TEMPLATE_NOT_FOUND' });
  });
});
