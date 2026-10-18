import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { ValidationError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listLearningPolicies, ratifyLearningPolicy } from '@/src/server/pilot/learningPolicies';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  const requirePrincipal = jest.fn();
  // The real Microsoft check over the mocked session, so the test can show a
  // non-Microsoft session refused.
  const requireMicrosoftAuthenticatedPrincipal = jest.fn(async (request: unknown) => {
    const principal = await requirePrincipal(request);
    if (principal.authProvider !== 'microsoft' || principal.signInMethod !== 'microsoft') {
      throw new Error('Forbidden: Microsoft-authenticated session required');
    }
    return principal;
  });
  return { ...actual, requirePrincipal, requireMicrosoftAuthenticatedPrincipal };
});

jest.mock('@/src/server/pilot/learningPolicies', () => {
  const actual = jest.requireActual('@/src/server/pilot/learningPolicies');
  return { ...actual, listLearningPolicies: jest.fn().mockResolvedValue([]), ratifyLearningPolicy: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listLearningPolicies as jest.Mock;
const mockRatify = ratifyLearningPolicy as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    signInMethod: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const URL_BASE = 'http://localhost/api/pilot/admin/learning-policies';
const postRequest = (body: Record<string, unknown>) =>
  new NextRequest(URL_BASE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const BODY = { kind: 'pattern_formation', parameters: { minimumOccurrences: 3 }, citations: [{ source: 'A study' }] };

test('staff read the bars; athletes, parents, the board and the platform owner do not', async () => {
  for (const role of ['athlete', 'parent', 'board', 'platform_owner'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(new NextRequest(URL_BASE))).status).toBe(403);
  }
  for (const role of ['coach', 'organization_admin', 'admin'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(new NextRequest(URL_BASE))).status).toBe(200);
  }
  expect(mockList).toHaveBeenCalledWith('org-1');
});

test('only a gym admin ratifies: a coach reads the bar but cannot set it', async () => {
  // Gym admin only (Jason 2026-10-18): the legacy admin role, which reads as
  // organization_admin elsewhere, does not ratify.
  for (const role of ['admin', 'coach', 'athlete', 'parent', 'board', 'platform_owner'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await POST(postRequest(BODY))).status).toBe(403);
  }
  expect(mockRatify).not.toHaveBeenCalled();
});

test('a ratification is signed by the caller, in their role and gym', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-office', role: 'organization_admin' }));
  mockRatify.mockResolvedValue({ policy_id: 'pol-1', version: 1 });
  const response = await POST(postRequest(BODY));
  expect(response.status).toBe(201);
  expect(mockRatify).toHaveBeenCalledWith({
    organizationId: 'org-1',
    kind: 'pattern_formation',
    parameters: { minimumOccurrences: 3 },
    citations: [{ source: 'A study' }],
    ratifiedByAccountId: 'acct-office',
    ratifiedByRole: 'organization_admin',
  });
  expect((await POST(postRequest({ parameters: {} }))).status).toBe(400);
});

test('a body that is not an object is refused as a 400, not a 500', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  for (const raw of ['null', '7', '[]']) {
    const response = await POST(new NextRequest(URL_BASE, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: raw,
    }));
    expect(response.status).toBe(400);
  }
  expect(mockRatify).not.toHaveBeenCalled();
});

test('ratifying needs a Microsoft-authenticated session; reading does not', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ signInMethod: null } as unknown as Partial<PilotPrincipal>));
  expect((await POST(postRequest(BODY))).status).toBe(403);
  expect((await GET(new NextRequest(URL_BASE))).status).toBe(200);
  expect(mockRatify).not.toHaveBeenCalled();
});

test("the module's reason reaches the admin as a 400", async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockRatify.mockRejectedValue(new ValidationError('A bar needs at least one cited source.'));
  const response = await POST(postRequest(BODY));
  expect(response.status).toBe(400);
  expect(JSON.stringify(await response.json())).toContain('cited source');
});
