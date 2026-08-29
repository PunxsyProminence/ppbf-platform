import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import {
  createCoachDevelopmentActivity,
  createCoachDevelopmentGoal,
  listCoachDevelopmentActivities,
  listCoachDevelopmentGoals,
  updateCoachDevelopmentGoal,
} from '@/src/server/pilot/coachDevelopment';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/*
 * The coach API over a coach's OWN development record.
 *
 * The property this file exists to hold is smaller and stronger than the one
 * the development-blocks route needed: there is no account id anywhere in the
 * request, on any method, so there is nothing to authorize against a person
 * other than the caller. Every assertion below is a version of "the account
 * the module was asked about is the SESSION's" -- because the moment that
 * stops being true, a coach can read a colleague's development goals, and
 * whether they may is a product question nobody has answered.
 *
 * The ownership and organization rules themselves are proven against real
 * Postgres in coachDevelopment.pg.test.ts (a colleague's goal is a hidden
 * not-found; the same account in two gyms sees two separate records). Nothing
 * here re-asserts them with mocks.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/coachDevelopment', () => {
  const actual = jest.requireActual('@/src/server/pilot/coachDevelopment');
  return {
    ...actual,
    createCoachDevelopmentGoal: jest.fn(),
    createCoachDevelopmentActivity: jest.fn(),
    listCoachDevelopmentGoals: jest.fn(),
    listCoachDevelopmentActivities: jest.fn(),
    updateCoachDevelopmentGoal: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockCreateGoal = createCoachDevelopmentGoal as jest.Mock;
const mockCreateActivity = createCoachDevelopmentActivity as jest.Mock;
const mockListGoals = listCoachDevelopmentGoals as jest.Mock;
const mockListActivities = listCoachDevelopmentActivities as jest.Mock;
const mockUpdateGoal = updateCoachDevelopmentGoal as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

beforeEach(() => {
  mockListGoals.mockResolvedValue([]);
  mockListActivities.mockResolvedValue([]);
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

function goal(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    goal_id: 'goal-1',
    coach_account_id: 'acct-coach-a',
    title: 'Corner work under pressure',
    development_focus: 'Keep the anxious kids in the room during hard rounds.',
    target_on: '2026-12-01',
    status: 'draft',
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

function activity(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    activity_id: 'act-1',
    coach_account_id: 'acct-coach-a',
    goal_id: null,
    title: 'Youth coaching clinic',
    provider: 'USA Boxing',
    occurred_on: '2026-03-12',
    duration_minutes: 180,
    notes: '',
    created_at: '2026-08-28T00:00:00.000Z',
    updated_at: '2026-08-28T00:00:00.000Z',
    ...overrides,
  };
}

function getRequest() {
  return new NextRequest('http://localhost/api/pilot/coach/development');
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/coach/development', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function patchRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/coach/development', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

describe('GET: a coach reads their own record and nobody else\'s', () => {
  test('both lists are read for the SESSION\'s account, in the session\'s organization', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockListGoals.mockResolvedValue([goal()]);
    mockListActivities.mockResolvedValue([activity()]);

    const response = await GET(getRequest());
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(mockListGoals).toHaveBeenCalledWith('org-1', 'acct-coach-a');
    expect(mockListActivities).toHaveBeenCalledWith('org-1', 'acct-coach-a');
    expect(payload.goals).toHaveLength(1);
    expect(payload.activities).toHaveLength(1);
  });

  test('a query string naming another account changes nothing -- there is no such parameter', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await GET(new NextRequest(
      'http://localhost/api/pilot/coach/development?account_id=acct-colleague&organization_id=org-2',
    ));

    expect(response.status).toBe(200);
    // The session's, both of them. This is the whole posture of the route:
    // there is no account parameter to forget to check.
    expect(mockListGoals).toHaveBeenCalledWith('org-1', 'acct-coach-a');
    expect(mockListActivities).toHaveBeenCalledWith('org-1', 'acct-coach-a');
  });

  test('the response is not cached, because a personal record must not be shared between sessions', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    const response = await GET(getRequest());
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  test.each(['athlete', 'parent', 'board', 'platform_owner'])(
    'a %s is refused',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));
      const response = await GET(getRequest());
      expect(response.status).toBe(403);
      expect(mockListGoals).not.toHaveBeenCalled();
      expect(mockListActivities).not.toHaveBeenCalled();
    },
  );

  test.each(['coach', 'organization_admin', 'admin', 'staff', 'volunteer'])(
    'a %s reads their own record',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));
      const response = await GET(getRequest());
      expect(response.status).toBe(200);
    },
  );
});

describe('POST: writing a goal', () => {
  test('the author and the organization are the session, never a value the caller sent', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockCreateGoal.mockResolvedValue(goal());

    const response = await POST(postRequest({
      kind: 'goal',
      title: 'Corner work under pressure',
      development_focus: 'Keep the anxious kids in the room.',
      // All three are ignored. A body that could move a goal to another gym,
      // or file it under a colleague's name, is the failure this asserts.
      organization_id: 'org-2',
      coach_account_id: 'acct-colleague',
      account_id: 'acct-colleague',
    }));

    expect(response.status).toBe(201);
    expect(mockCreateGoal).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      coachAccountId: 'acct-coach-a',
    }));
  });

  test('an unknown status is refused rather than quietly becoming the default', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await POST(postRequest({
      kind: 'goal',
      title: 'A',
      development_focus: 'B',
      status: 'abandoned',
    }));

    expect(response.status).toBe(400);
    expect(mockCreateGoal).not.toHaveBeenCalled();
  });

  test('a missing or unknown kind is refused', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    for (const body of [{}, { kind: 'credential' }, { kind: 42 }]) {
      const response = await POST(postRequest(body as Record<string, unknown>));
      expect(response.status).toBe(400);
    }
    expect(mockCreateGoal).not.toHaveBeenCalled();
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  test.each(['athlete', 'parent', 'board', 'platform_owner'])(
    'a %s cannot write a goal',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));
      const response = await POST(postRequest({ kind: 'goal', title: 'A', development_focus: 'B' }));
      expect(response.status).toBe(403);
      expect(mockCreateGoal).not.toHaveBeenCalled();
    },
  );
});

describe('POST: writing an activity', () => {
  test('the author and the organization are the session here too', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockCreateActivity.mockResolvedValue(activity());

    const response = await POST(postRequest({
      kind: 'activity',
      title: 'Youth coaching clinic',
      provider: 'USA Boxing',
      occurred_on: '2026-03-12',
      duration_minutes: 180,
      organization_id: 'org-2',
      coach_account_id: 'acct-colleague',
    }));

    expect(response.status).toBe(201);
    expect(mockCreateActivity).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      coachAccountId: 'acct-coach-a',
      title: 'Youth coaching clinic',
      occurredOn: '2026-03-12',
      durationMinutes: 180,
    }));
  });

  test('a goal the coach does not own is a 404, indistinguishable from one that never existed', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    // The module returns null for both cases on purpose. A response that
    // distinguished them would let any coach probe for colleagues' goal ids.
    mockCreateActivity.mockResolvedValue(null);

    const response = await POST(postRequest({
      kind: 'activity',
      title: 'Clinic',
      occurred_on: '2026-03-12',
      goal_id: 'goal-belonging-to-someone-else',
    }));

    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Goal not found.');
  });

  test('a duration that is not a number is refused, never coerced', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    for (const bad of ['two hours', 'abc', {}]) {
      const response = await POST(postRequest({
        kind: 'activity',
        title: 'Clinic',
        occurred_on: '2026-03-12',
        duration_minutes: bad,
      }));
      // Number("two hours") is NaN and Number("") is 0. Both would put a
      // figure in the database that the coach did not type.
      expect(response.status).toBe(400);
    }
    expect(mockCreateActivity).not.toHaveBeenCalled();
  });

  test('an omitted, empty or null duration reaches the module as null, not as zero', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockCreateActivity.mockResolvedValue(activity({ duration_minutes: null }));

    for (const body of [
      { kind: 'activity', title: 'C', occurred_on: '2026-03-12' },
      { kind: 'activity', title: 'C', occurred_on: '2026-03-12', duration_minutes: '' },
      { kind: 'activity', title: 'C', occurred_on: '2026-03-12', duration_minutes: null },
    ]) {
      mockCreateActivity.mockClear();
      await POST(postRequest(body));
      expect(mockCreateActivity).toHaveBeenCalledWith(
        expect.objectContaining({ durationMinutes: null }),
      );
    }
  });

  test('a numeric string is read as the number the coach typed', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockCreateActivity.mockResolvedValue(activity());

    await POST(postRequest({
      kind: 'activity', title: 'C', occurred_on: '2026-03-12', duration_minutes: ' 90 ',
    }));

    expect(mockCreateActivity).toHaveBeenCalledWith(
      expect.objectContaining({ durationMinutes: 90 }),
    );
  });
});

describe('PATCH: correcting a goal', () => {
  test('the goal is looked up under the SESSION\'s account, never one the body names', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockUpdateGoal.mockResolvedValue(goal({ status: 'active' }));

    const response = await PATCH(patchRequest({
      goal_id: 'goal-1',
      status: 'active',
      coach_account_id: 'acct-colleague',
      organization_id: 'org-2',
    }));

    expect(response.status).toBe(200);
    expect(mockUpdateGoal).toHaveBeenCalledWith(
      'org-1', 'acct-coach-a', 'goal-1', { status: 'active' },
    );
  });

  test('a goal that is not the caller\'s is a 404', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockUpdateGoal.mockResolvedValue(null);

    const response = await PATCH(patchRequest({ goal_id: 'goal-theirs', status: 'active' }));
    expect(response.status).toBe(404);
  });

  test('a missing goal_id is refused', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    const response = await PATCH(patchRequest({ status: 'active' }));
    expect(response.status).toBe(400);
    expect(mockUpdateGoal).not.toHaveBeenCalled();
  });

  test('an omitted key is not in the patch at all, so it cannot blank a field', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockUpdateGoal.mockResolvedValue(goal());

    await PATCH(patchRequest({ goal_id: 'goal-1', status: 'completed' }));

    const patch = mockUpdateGoal.mock.calls[0][3];
    expect(patch).toEqual({ status: 'completed' });
    expect('title' in patch).toBe(false);
    expect('developmentFocus' in patch).toBe(false);
    expect('targetOn' in patch).toBe(false);
  });

  test('an explicit null or empty target_on clears the date', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockUpdateGoal.mockResolvedValue(goal({ target_on: null }));

    for (const value of [null, '']) {
      mockUpdateGoal.mockClear();
      await PATCH(patchRequest({ goal_id: 'goal-1', target_on: value }));
      // Present-and-null, not absent: the module distinguishes "clear it"
      // from "leave it alone", and a coach has to be able to say the first.
      expect(mockUpdateGoal.mock.calls[0][3]).toEqual({ targetOn: null });
    }
  });

  test('a whitespace-only target_on is refused rather than read as "clear it"', async () => {
    /* THIS REVERSES A DECISION THIS TEST USED TO ENCODE. It looped
       [null, '', '   '] and expected all three to clear the date. A review
       pointed out the asymmetry that made that wrong: POST refuses '   '
       with a 400 ("target_on must be a calendar date written as
       YYYY-MM-DD"), so the identical value meant "that is not a date" on one
       verb and "delete the date you have" on the other -- and the
       destructive reading was the silent one.

       Whitespace is not reachable from the date input, which yields '' when
       emptied, so it can only arrive from a client that is already confused.
       Refusing ambiguity on the destructive path is the safer half of the
       choice, and '' still clears, which is what the UI actually sends. */
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await PATCH(patchRequest({ goal_id: 'goal-1', target_on: '   ' }));

    expect(response.status).toBe(400);
    expect(mockUpdateGoal).not.toHaveBeenCalled();
  });

  test('an unknown status is refused and nothing is written', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await PATCH(patchRequest({ goal_id: 'goal-1', status: 'archived' }));
    expect(response.status).toBe(400);
    expect(mockUpdateGoal).not.toHaveBeenCalled();
  });

  test.each(['athlete', 'parent', 'board', 'platform_owner'])(
    'a %s cannot correct a goal',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));
      const response = await PATCH(patchRequest({ goal_id: 'goal-1', status: 'active' }));
      expect(response.status).toBe(403);
      expect(mockUpdateGoal).not.toHaveBeenCalled();
    },
  );
});

describe('what this route refuses to be', () => {
  test('no response carries a progress, percentage, score or hours total', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockListGoals.mockResolvedValue([goal(), goal({ goal_id: 'goal-2' })]);
    mockListActivities.mockResolvedValue([
      activity({ duration_minutes: 60 }),
      activity({ activity_id: 'act-2', duration_minutes: 120 }),
    ]);

    const body = await (await GET(getRequest())).text();

    // Not a spelling check: these are the shapes the Coach Goals tab shipped
    // with (hardcoded bars reading the same percentage for every coach) and
    // the CEU-style total the migration header refuses. A summed figure built
    // from unverified self-report, sitting beside a certification band, reads
    // as compliance evidence.
    for (const forbidden of [
      'progress', 'percent', 'completion', 'score', 'level', 'rank',
      'total_minutes', 'total_hours', 'hours_total', 'ceu',
    ]) {
      expect(body).not.toContain(forbidden);
    }
    // Guards the guard: the payload really did carry both lists.
    expect(body).toContain('goal-2');
    expect(body).toContain('act-2');
  });

  test('nothing in a response claims a clearance', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockListActivities.mockResolvedValue([activity({ title: 'SafeSport refresher' })]);

    const body = await (await GET(getRequest())).text();

    // A coach may well log a SafeSport refresher here. What must never come
    // back with it is anything that reads as verification -- that record
    // lives in pilot.person_clearances and is confirmed by an administrator.
    expect(body).toContain('SafeSport refresher');
    for (const forbidden of ['verified', 'clearance', 'expires_on', 'issued_on', 'document_ref']) {
      expect(body).not.toContain(forbidden);
    }
  });
});
