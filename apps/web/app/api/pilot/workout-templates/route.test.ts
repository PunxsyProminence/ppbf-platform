import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  getWorkoutTemplateWithItems,
  listWorkoutTemplates,
} from '@/src/server/pilot/workoutTemplates';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

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
   * The route calls `requirePrincipal` and deliberately NOT `requireRole`:
   * its own comment says "Any authenticated role can browse; a template
   * carries no athlete data." That is a real decision and it was asserted
   * nowhere, so a `requireRole` added later would tighten the route silently.
   * This pins the decision; if the decision changes, this test should be
   * changed with it, deliberately.
   */
  test('an athlete may browse the catalogue', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockList.mockResolvedValue([TEMPLATE]);

    expect((await GET(getRequest())).status).toBe(200);
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
