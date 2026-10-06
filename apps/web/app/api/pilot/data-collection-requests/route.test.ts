import { NextRequest } from 'next/server';

import { DELETE, GET, PATCH, POST } from './route';
import { accessibleAthleteIds, assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import {
  captureDataCollectionRequest,
  createDataCollectionRequest,
  declineDataCollectionRequest,
  getDataCollectionRequestAthleteId,
  listOpenDataCollectionRequests,
} from '@/src/server/pilot/assessmentProtocols';
import { queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return {
    ...actual,
    assertActorCanAccessAthlete: jest.fn(),
    accessibleAthleteIds: jest.fn().mockResolvedValue(new Set()),
  };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

// The route's two lookups of its own: the person's membership in this gym
// (create) and the assessment's athlete (capture).
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));

jest.mock('@/src/server/pilot/assessmentProtocols', () => ({
  listOpenDataCollectionRequests: jest.fn().mockResolvedValue([]),
  createDataCollectionRequest: jest.fn(),
  captureDataCollectionRequest: jest.fn(),
  declineDataCollectionRequest: jest.fn(),
  getDataCollectionRequestAthleteId: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockAccessible = accessibleAthleteIds as jest.Mock;
const mockList = listOpenDataCollectionRequests as jest.Mock;
const mockCreate = createDataCollectionRequest as jest.Mock;
const mockCapture = captureDataCollectionRequest as jest.Mock;
const mockDecline = declineDataCollectionRequest as jest.Mock;
const mockGetOwner = getDataCollectionRequestAthleteId as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

// The athlete gate is permissive by default so each test states its own
// access decision rather than inheriting the previous test's --
// clearAllMocks clears calls, not implementations.
beforeEach(() => {
  mockAccess.mockResolvedValue(undefined);
  mockAccessible.mockResolvedValue(new Set());
  mockList.mockResolvedValue([]);
  mockGetOwner.mockResolvedValue({ athlete_id: 'ath-1' });
  mockCapture.mockResolvedValue({ request_id: 'req-1', status: 'captured' });
  mockDecline.mockResolvedValue({ request_id: 'req-1', status: 'declined' });
  mockQueryOne.mockResolvedValue({ found: 1 });
});

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = (query = '') =>
  new NextRequest(`http://localhost/api/pilot/data-collection-requests${query}`);

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/data-collection-requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const REQUEST_BODY = {
  request_kind: 'photo',
  prompt_text: 'Photo of the guard position from the left',
  reason_code: 'rubric_evidence_missing',
};

test('athletes, parents, and volunteers have no path into the capture queue', async () => {
  for (const role of ['athlete', 'parent', 'volunteer'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
    expect((await POST(postRequest({ ...REQUEST_BODY, athlete_id: 'ath-1' }))).status)
      .toBeGreaterThanOrEqual(400);
  }
  expect(mockList).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
});

test('a coach with no relationship to the named child reads nothing and files nothing', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

  expect((await GET(getRequest('?athlete_id=ath-not-mine'))).status).toBe(403);
  expect((await POST(postRequest({ ...REQUEST_BODY, athlete_id: 'ath-not-mine' }))).status).toBe(403);

  expect(mockList).not.toHaveBeenCalled();
  expect(mockCreate).not.toHaveBeenCalled();
});

test('a filtered read passes the gated athlete straight through to the queue', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockList.mockResolvedValueOnce([{ request_id: 'req-1', athlete_id: 'ath-mine' }]);

  const response = await GET(getRequest('?athlete_id=%20ath-mine%20'));

  expect(response.status).toBe(200);
  expect(mockAccess).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: 'acct-1', role: 'coach' }),
    'ath-mine',
  );
  expect(mockList).toHaveBeenCalledWith('org-1', expect.objectContaining({ athleteId: 'ath-mine' }));
  // Already narrowed to one authorized athlete -- no second scope pass.
  expect(mockAccessible).not.toHaveBeenCalled();
});

// CL-A11 (overwatch ruling A11 = a): a request that names only a person
// account is organization-admin business. It used to be listed to every coach.
test('an unfiltered coach queue is scoped to the caller\'s reachable children, and drops person-only requests', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockList.mockResolvedValueOnce([
    { request_id: 'req-mine', athlete_id: 'ath-mine' },
    { request_id: 'req-theirs', athlete_id: 'ath-theirs' },
    { request_id: 'req-person', athlete_id: null, person_account_id: 'acct-9' },
  ]);
  mockAccessible.mockResolvedValueOnce(new Set(['ath-mine']));

  const response = await GET(getRequest());

  expect(response.status).toBe(200);
  expect(mockAccessible).toHaveBeenCalledWith(
    expect.objectContaining({ accountId: 'acct-1', role: 'coach' }),
    ['ath-mine', 'ath-theirs'],
  );
  const payload = (await response.json()) as { requests: Array<{ request_id: string }> };
  expect(payload.requests.map((row) => row.request_id)).toEqual(['req-mine']);
});

test('a coach cannot filter the queue by person account (CL-A11)', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  const response = await GET(getRequest('?person_account_id=acct-9'));

  expect(response.status).toBe(403);
  expect(mockList).not.toHaveBeenCalled();
});

test('an organization admin still sees person-only requests (CL-A11)', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
  mockList.mockResolvedValueOnce([
    { request_id: 'req-kid', athlete_id: 'ath-1' },
    { request_id: 'req-person', athlete_id: null, person_account_id: 'acct-9' },
  ]);
  mockAccessible.mockResolvedValueOnce(new Set(['ath-1']));

  const payload = (await (await GET(getRequest())).json()) as { requests: Array<{ request_id: string }> };

  expect(payload.requests.map((row) => row.request_id)).toEqual(['req-kid', 'req-person']);
});

test('an organization admin keeps organization-wide reach -- the route defers to the central contract', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
  // Which athletes an org admin may reach is assertActorCanAccessAthlete's
  // decision (access.test.ts: 'allows organization_admin when athlete belongs
  // to their organization'); this route adds no narrower rule of its own.
  mockAccess.mockResolvedValue(undefined);
  mockCreate.mockResolvedValue({ request_id: 'req-1', request_kind: 'photo', reason_code: 'rubric_evidence_missing' });

  const response = await POST(postRequest({ ...REQUEST_BODY, athlete_id: 'ath-nobody-coaches' }));

  expect(response.status).toBe(200);
  expect(mockAccess).toHaveBeenCalledWith(
    expect.objectContaining({ role: 'organization_admin', organizationId: 'org-1' }),
    'ath-nobody-coaches',
  );
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ athleteId: 'ath-nobody-coaches' }));
});

test('a coach cannot file a person-only request (CL-A11)', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  const response = await POST(postRequest({ ...REQUEST_BODY, person_account_id: 'acct-volunteer' }));

  expect(response.status).toBe(403);
  expect(mockCreate).not.toHaveBeenCalled();
});

test('a person account outside this organization is refused before anything is written (CL-A11)', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
  mockQueryOne.mockResolvedValueOnce(null); // no active membership in org-1

  const response = await POST(postRequest({ ...REQUEST_BODY, person_account_id: 'acct-other-gym' }));

  expect(response.status).toBe(400);
  expect(mockQueryOne).toHaveBeenCalledWith(expect.stringContaining('organization_memberships'), ['acct-other-gym', 'org-1']);
  expect(mockCreate).not.toHaveBeenCalled();
});

test('an organization admin files a request about a non-athlete person in this gym, with no athlete gate', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
  mockCreate.mockResolvedValue({ request_id: 'req-2', request_kind: 'document', reason_code: 'waiver_missing' });

  const response = await POST(postRequest({
    request_kind: 'document',
    prompt_text: 'Signed waiver from the volunteer',
    reason_code: 'waiver_missing',
    person_account_id: 'acct-volunteer',
  }));

  expect(response.status).toBe(200);
  expect(mockAccess).not.toHaveBeenCalled();
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    athleteId: undefined, personAccountId: 'acct-volunteer',
  }));
});


const patchRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/data-collection-requests', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const deleteRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/data-collection-requests', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('capture (PATCH) and decline (DELETE) authorize the request athlete before mutating', () => {
  // The bug: GET and POST gate per athlete, but PATCH and DELETE acted on a
  // client-supplied request_id with no athlete gate, so a coach could capture or
  // decline a data-collection request for a minor outside their care.
  test('refuse with 403 when the caller cannot reach the request’s athlete, and nothing is mutated', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-coach' }));
    mockGetOwner.mockResolvedValue({ athlete_id: 'ath-out' });
    mockAccess.mockImplementation(async (_p: unknown, id: string) => {
      if (id === 'ath-out') throw new Error('Forbidden: not your athlete');
    });

    expect((await PATCH(patchRequest({ request_id: 'req-1', media_ref: 'blob://x' }))).status).toBe(403);
    expect(mockCapture).not.toHaveBeenCalled();

    expect((await DELETE(deleteRequest({ request_id: 'req-1', declined_reason: 'n/a' }))).status).toBe(403);
    expect(mockDecline).not.toHaveBeenCalled();
  });

  test('404 a request_id that names no row in the organization, without mutating', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-coach' }));
    mockGetOwner.mockResolvedValue(null);

    expect((await PATCH(patchRequest({ request_id: 'req-ghost' }))).status).toBe(404);
    expect(mockCapture).not.toHaveBeenCalled();
  });

  test('a coach cannot capture or decline a person-only request (CL-A11)', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-coach' }));
    mockGetOwner.mockResolvedValue({ athlete_id: null });

    expect((await PATCH(patchRequest({ request_id: 'req-1', media_ref: 'blob://x' }))).status).toBe(403);
    expect(mockCapture).not.toHaveBeenCalled();
    expect((await DELETE(deleteRequest({ request_id: 'req-1', declined_reason: 'n/a' }))).status).toBe(403);
    expect(mockDecline).not.toHaveBeenCalled();
  });

  test('an organization admin captures a person-only request with no athlete gate', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
    mockGetOwner.mockResolvedValue({ athlete_id: null });

    expect((await PATCH(patchRequest({ request_id: 'req-1', media_ref: 'blob://x' }))).status).toBe(200);
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockCapture).toHaveBeenCalledTimes(1);
  });

  test('capture and decline proceed once the athlete gate passes', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-coach' }));
    mockGetOwner.mockResolvedValue({ athlete_id: 'ath-1' });

    expect((await PATCH(patchRequest({ request_id: 'req-1', media_ref: 'blob://x' }))).status).toBe(200);
    expect(mockCapture).toHaveBeenCalledTimes(1);

    expect((await DELETE(deleteRequest({ request_id: 'req-1', declined_reason: 'blurry' }))).status).toBe(200);
    expect(mockDecline).toHaveBeenCalledTimes(1);
  });
});

// CL-A11, second half (the audit's LIKELY finding, proved here):
// resulting_assessment_id was stored as sent. A coach capturing a request
// about their own athlete could record another child's assessment -- or one
// from another gym -- as the evidence for it.
describe('capture binds resulting_assessment_id to the request athlete (CL-A11)', () => {
  test("an assessment that is not this athlete's, in this gym, is refused and nothing is captured", async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-coach' }));
    mockGetOwner.mockResolvedValue({ athlete_id: 'ath-1' });
    mockQueryOne.mockResolvedValueOnce(null); // no such assessment for ath-1 in org-1

    const response = await PATCH(patchRequest({ request_id: 'req-1', resulting_assessment_id: 'asmt-other-child' }));

    expect(response.status).toBe(400);
    expect(mockQueryOne).toHaveBeenCalledWith(
      expect.stringContaining('pilot.assessments'),
      ['org-1', 'asmt-other-child', 'ath-1'],
    );
    expect(mockCapture).not.toHaveBeenCalled();
  });

  test("the athlete's own assessment is accepted", async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-coach' }));
    mockGetOwner.mockResolvedValue({ athlete_id: 'ath-1' });

    const response = await PATCH(patchRequest({ request_id: 'req-1', resulting_assessment_id: 'asmt-mine' }));

    expect(response.status).toBe(200);
    expect(mockCapture).toHaveBeenCalledWith(expect.objectContaining({ resultingAssessmentId: 'asmt-mine' }));
  });

  test('a person-only request takes no assessment at all', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
    mockGetOwner.mockResolvedValue({ athlete_id: null });

    const response = await PATCH(patchRequest({ request_id: 'req-1', resulting_assessment_id: 'asmt-any' }));

    expect(response.status).toBe(400);
    expect(mockCapture).not.toHaveBeenCalled();
  });
});
