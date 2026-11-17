import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listBehaviorKpis } from '@/src/server/pilot/behaviorKpis';
import { COACHING_CONTENT_READER_ROLES } from '@/src/server/pilot/coachingContentAccess';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/behaviorKpis', () => ({ listBehaviorKpis: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listBehaviorKpis as jest.Mock;

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

const request = () => new NextRequest('http://localhost/api/pilot/coach/behavior-kpis');
const LISTS = [{ listKey: 'drill', title: 'Core Drill KPIs Worth Scoring', sourceDoc: 'DOC-041', scoringRuleText: 'x', kpis: [] }];

test('the role check is the drill library route\'s own, and each reader reads its own organization', async () => {
  mockList.mockResolvedValue(LISTS);
  for (const role of COACHING_CONTENT_READER_ROLES) {
    mockRequirePrincipal.mockResolvedValue(principal({ role, organizationId: `org-${role}` }));
    const response = await GET(request());
    expect([role, response.status]).toEqual([role, 200]);
    expect(await response.json()).toEqual({ lists: LISTS });
    expect(mockList).toHaveBeenLastCalledWith(`org-${role}`);
  }
});

test('an athlete reads only their own gym\'s lists', async () => {
  mockList.mockResolvedValue(LISTS);
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', organizationId: 'org-1', athleteId: 'ath-1' }));
  const response = await GET(request());
  expect(response.status).toBe(200);
  expect(mockList).toHaveBeenCalledTimes(1);
  expect(mockList).toHaveBeenCalledWith('org-1');
});

test('a coach of another gym reads that gym\'s lists, never this one\'s: the organization comes from the session only', async () => {
  mockList.mockResolvedValue([]);
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach', organizationId: 'org-other' }));
  const response = await GET(new NextRequest('http://localhost/api/pilot/coach/behavior-kpis?organization_id=org-1'));
  expect(response.status).toBe(200);
  expect(mockList).toHaveBeenCalledTimes(1);
  expect(mockList).toHaveBeenCalledWith('org-other');
  expect(await response.json()).toEqual({ lists: [] });
});

test('a signed-out caller gets 401 and nothing is read', async () => {
  mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));
  const response = await GET(request());
  expect(response.status).toBe(401);
  expect(mockList).not.toHaveBeenCalled();
});

test('a role outside the drill library\'s readers is refused before anything is read', async () => {
  for (const role of ['board'] as PilotRole[]) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    const response = await GET(request());
    expect([role, response.status]).toEqual([role, 403]);
  }
  expect(mockList).not.toHaveBeenCalled();
});
