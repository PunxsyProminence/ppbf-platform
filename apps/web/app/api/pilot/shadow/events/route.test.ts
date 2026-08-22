import { NextRequest } from 'next/server';

import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { POST } from './route';

/**
 * Route-level coverage for /api/pilot/shadow/events, which had none.
 *
 * WHY THIS FILE EXISTS. This route accepts a caller-supplied athlete
 * identifier -- `entity_type: 'athlete'` plus `entity_id` -- behind a role gate
 * that includes coach, and hands both straight to listShadowEvents. Until the
 * scope fix in shadowReadModels.ts, resolveAthleteScope answered a coach with
 * "no athlete restriction at all", and roleCanViewSensitivePayload returns true
 * for a coach, so any coach could name any child in the organization and read
 * that child's pain reports with body site, pain type and severity intact.
 *
 * So the property pinned here is not "the filter is forwarded" -- it is that
 * the caller's `entity_id` and the actor's ACCESS BOUNDARY are two different
 * things, and only the second one comes from the principal. The read model is
 * deliberately NOT mocked: the point is the wiring, that the route reaches the
 * real resolveAthleteScope with the real principal. Only the database beneath
 * it is faked. Mocking listShadowEvents would re-create the gap this file
 * closes -- every assertion below would still pass with the scope resolver
 * removed entirely.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowReadiness', () => ({
  assertShadowRuntimeReadiness: jest.fn(),
}));

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockReadiness = assertShadowRuntimeReadiness as jest.Mock;
const mockQuery = query as jest.Mock;

beforeEach(() => {
  mockReadiness.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/shadow/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** The coach roster lookup (athleteIdsForCoach) is always the first query. */
function answerCoachRoster(athleteIds: string[]): void {
  mockQuery.mockResolvedValueOnce(athleteIds.map((athlete_id) => ({ athlete_id })));
}

const PAIN_ROW = {
  shadow_event_id: 1,
  organization_id: 'org-1',
  event_name: 'SHADOW_ATHLETE_PAIN_REPORT_PENDING_REVIEW',
  entity_type: 'athlete',
  entity_id: 'ath-not-mine',
  actor_account_id: 'acct-x',
  actor_role: 'athlete',
  payload: { athlete_id: 'ath-not-mine', severity_1_10: 9, location: 'ribs', pain_type: 'stabbing' },
  created_at: '2026-08-20T00:00:00.000Z',
};

describe('POST /api/pilot/shadow/events -- athlete boundary', () => {
  test("a coach naming another coach's athlete is bound to their own roster, not to the id they asked for", async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    answerCoachRoster(['ath-mine']);
    mockQuery.mockResolvedValueOnce([]);

    const response = await POST(postRequest({ entity_type: 'athlete', entity_id: 'ath-not-mine' }));
    expect(response.status).toBe(200);

    // The roster lookup is keyed on the PRINCIPAL, and nothing from the body
    // reaches it.
    expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', 'coach-1']);

    const eventsParams = mockQuery.mock.calls[1][1];
    // $3 is the caller's entity_id filter -- a narrowing convenience.
    expect(eventsParams[2]).toBe('ath-not-mine');
    // $9 is the boundary. It is the coach's roster, and the requested id is
    // absent from it, so the row cannot be returned however it was asked for.
    expect(eventsParams[8]).toEqual(['ath-mine']);
    expect(eventsParams[8]).not.toContain('ath-not-mine');
    expect(eventsParams[9]).toBe(true);
  });

  test('the same boundary applies on the timeline branch', async () => {
    // getShadowEventTimeline delegates to listShadowEvents; a second entry
    // point into the same route must not be a second scope decision.
    mockRequirePrincipal.mockResolvedValue(principal({}));
    answerCoachRoster(['ath-mine']);
    mockQuery.mockResolvedValueOnce([]);

    const response = await POST(
      postRequest({ timeline: true, entity_type: 'athlete', entity_id: 'ath-not-mine', correlation_id: 'case-1' }),
    );
    expect(response.status).toBe(200);

    const eventsParams = mockQuery.mock.calls[1][1];
    expect(eventsParams[8]).toEqual(['ath-mine']);
    expect(eventsParams[9]).toBe(true);
    expect(eventsParams[5]).toBe('case-1');
  });

  test('the organization is taken from the principal, never from the request body', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    answerCoachRoster([]);
    mockQuery.mockResolvedValueOnce([]);

    const response = await POST(postRequest({ organization_id: 'org-other' }));
    const body = await response.json();

    expect(mockQuery.mock.calls[0][1][0]).toBe('org-1');
    expect(mockQuery.mock.calls[1][1][0]).toBe('org-1');
    expect(body.organization_id).toBe('org-1');
  });

  test('an athlete principal is bound to their own athleteId', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', accountId: 'acct-a', athleteId: 'ath-self' }));
    mockQuery.mockResolvedValueOnce([]);

    await POST(postRequest({ entity_type: 'athlete', entity_id: 'ath-someone-else' }));

    const eventsParams = mockQuery.mock.calls[0][1];
    expect(eventsParams[8]).toEqual(['ath-self']);
    expect(eventsParams[9]).toBe(false);
  });

  test.each(['volunteer', 'staff', 'platform_owner'] as const)(
    '%s reaches no athlete-tied row through this route',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role }));
      mockQuery.mockResolvedValueOnce([]);

      const response = await POST(postRequest({ entity_type: 'athlete', entity_id: 'ath-not-mine' }));
      expect(response.status).toBe(200);

      const eventsParams = mockQuery.mock.calls[0][1];
      expect(eventsParams[8]).toEqual([]);
      expect(eventsParams[9]).toBe(true);
    },
  );

  test('a coach still receives the pain detail for a row inside their own roster', async () => {
    // The counterpart to the boundary: describePainReportEvent renders
    // location, pain_type and severity into the coach's feed label, so
    // redacting the coach would blank the label they act on. The scope is what
    // makes this legitimate, and the two must be tested together or a later
    // "tighten the sanitizer" edit looks free.
    mockRequirePrincipal.mockResolvedValue(principal({}));
    answerCoachRoster(['ath-mine']);
    mockQuery.mockResolvedValueOnce([
      { ...PAIN_ROW, entity_id: 'ath-mine', payload: { ...PAIN_ROW.payload, athlete_id: 'ath-mine' } },
    ]);

    const body = await (await POST(postRequest({}))).json();

    expect(body.events[0].payload).toEqual({
      athlete_id: 'ath-mine',
      severity_1_10: 9,
      location: 'ribs',
      pain_type: 'stabbing',
    });
  });

  test('a role without the sensitive-payload grant gets the safe keys only', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'volunteer' }));
    mockQuery.mockResolvedValueOnce([{ ...PAIN_ROW, payload: { ...PAIN_ROW.payload, entity_id: 'ath-not-mine' } }]);

    const body = await (await POST(postRequest({}))).json();

    expect(body.events[0].payload).toEqual({ entity_id: 'ath-not-mine' });
    expect(JSON.stringify(body)).not.toContain('stabbing');
  });
});

describe('POST /api/pilot/shadow/events -- gate and wiring', () => {
  test('board is outside SHADOW_PROJECTION_READ_ROLES and never reaches the database', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'board' }));

    const response = await POST(postRequest({}));

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockReadiness).not.toHaveBeenCalled();
  });

  test('an unauthenticated caller gets 401 and no query runs', async () => {
    mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));

    const response = await POST(postRequest({}));

    expect(response.status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('readiness is asserted for shadow_events before anything is read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    answerCoachRoster([]);
    mockQuery.mockResolvedValueOnce([]);

    await POST(postRequest({}));

    expect(mockReadiness).toHaveBeenCalledWith({ requiredTables: ['shadow_events'] });
  });

  test('the body filters reach the query in their server-side spelling', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
    mockQuery.mockResolvedValueOnce([]);

    await POST(
      postRequest({
        limit: 5,
        offset: 10,
        entity_type: 'intake_case',
        entity_id: 'case-1',
        event_name: 'SHADOW_INTAKE_DOCUMENT_UPLOADED',
        correlation_id: 'corr-1',
        created_after: '2026-08-01T00:00:00.000Z',
      }),
    );

    const params = mockQuery.mock.calls[0][1];
    expect(params[1]).toBe('intake_case');
    expect(params[2]).toBe('case-1');
    expect(params[3]).toBe('SHADOW_INTAKE_DOCUMENT_UPLOADED');
    expect(params[4]).toBe('2026-08-01T00:00:00.000Z');
    expect(params[5]).toBe('corr-1');
    expect(params[6]).toBe(5);
    expect(params[7]).toBe(10);
  });

  test('a malformed body is read as no filters rather than failing the request', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
    mockQuery.mockResolvedValueOnce([]);

    const request = new NextRequest('http://localhost/api/pilot/shadow/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });

    const response = await POST(request);

    expect(response.status).toBe(200);
    expect(mockQuery.mock.calls[0][1][1]).toBeNull();
  });

  test('the response carries ok, the principal organization, and the events', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
    mockQuery.mockResolvedValueOnce([{ ...PAIN_ROW, payload: {} }]);

    const body = await (await POST(postRequest({}))).json();

    expect(body.ok).toBe(true);
    expect(body.organization_id).toBe('org-1');
    expect(body.events).toHaveLength(1);
    expect(body.events[0].shadow_event_id).toBe(1);
  });
});
