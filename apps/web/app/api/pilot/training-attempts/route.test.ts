import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listAttempts, recordAttempt } from '@/src/server/pilot/trainingAttempts';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/trainingAttempts', () => {
  const actual = jest.requireActual('@/src/server/pilot/trainingAttempts');
  return { ...actual, listAttempts: jest.fn(), recordAttempt: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockList = listAttempts as jest.Mock;
const mockRecord = recordAttempt as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
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

const getRequest = (query: string) =>
  new NextRequest(`http://localhost/api/pilot/training-attempts?${query}`);

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/training-attempts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('a parent has no path in -- an athlete\'s failure log is not a family scoreboard', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent' }));

  expect((await GET(getRequest('athlete_id=ath-1'))).status).toBeGreaterThanOrEqual(400);
  expect((await POST(postRequest({ athlete_id: 'ath-1', metric_kind: 'reps', achieved_value: 5 }))).status).toBeGreaterThanOrEqual(400);
  expect(mockList).not.toHaveBeenCalled();
  expect(mockRecord).not.toHaveBeenCalled();
});

test('the athlete-access check runs before any read or write', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', athleteId: 'ath-1' }));
  mockAccess.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));

  expect((await GET(getRequest('athlete_id=ath-2'))).status).toBeGreaterThanOrEqual(400);
  expect((await POST(postRequest({ athlete_id: 'ath-2', metric_kind: 'reps', achieved_value: 5 }))).status).toBeGreaterThanOrEqual(400);
  expect(mockList).not.toHaveBeenCalled();
  expect(mockRecord).not.toHaveBeenCalled();
});

test('a coach records for their athlete with the verdict left to the module', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockResolvedValue(undefined);
  mockRecord.mockResolvedValue({ attempt_id: 'att-1' });

  const response = await POST(postRequest({
    athlete_id: ' ath-1 ',
    metric_kind: 'time_seconds',
    target_value: 90,
    achieved_value: 92,
    note: 'gassed at 300m',
  }));

  expect(response.status).toBe(200);
  expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
    organizationId: 'org-1',
    athleteId: 'ath-1',
    metricKind: 'time_seconds',
    targetValue: 90,
    achievedValue: 92,
    recordedByAccountId: 'acct-1',
  }));
  // 'made' is never accepted from the caller.
  expect(Object.keys(mockRecord.mock.calls[0][0])).not.toContain('made');
});

test('validation refuses unknown metrics, negative achieved, and non-positive targets', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockResolvedValue(undefined);

  expect((await POST(postRequest({ athlete_id: 'a', metric_kind: 'vibes', achieved_value: 5 }))).status).toBe(400);
  expect((await POST(postRequest({ athlete_id: 'a', metric_kind: 'reps', achieved_value: -1 }))).status).toBe(400);
  expect((await POST(postRequest({ athlete_id: 'a', metric_kind: 'reps', achieved_value: 5, target_value: 0 }))).status).toBe(400);
  expect(mockRecord).not.toHaveBeenCalled();
});

test('the list read is scoped and filterable', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockResolvedValue(undefined);
  mockList.mockResolvedValue([]);

  expect((await GET(getRequest('athlete_id=ath-1&metric_kind=reps'))).status).toBe(200);
  expect(mockList).toHaveBeenCalledWith('org-1', 'ath-1', { metricKind: 'reps' });
  expect((await GET(getRequest('athlete_id=ath-1&metric_kind=vibes'))).status).toBe(400);
});
