import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listBehaviorKpis } from '@/src/server/pilot/behaviorKpis';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/behaviorKpis', () => ({ ...jest.requireActual('@/src/server/pilot/behaviorKpis'), listBehaviorKpis: jest.fn() }));

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

test('a coach, an organization admin and an admin read their own organization\'s lists', async () => {
  const lists = [{ listKey: 'drill', title: 'Core Drill KPIs Worth Scoring', sourceDoc: 'DOC-041', scoringRuleText: 'x', kpis: [] }];
  mockList.mockResolvedValue(lists);
  for (const role of ['coach', 'organization_admin', 'admin'] as PilotRole[]) {
    mockRequirePrincipal.mockResolvedValue(principal({ role, organizationId: 'org-7' }));
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ lists });
    expect(mockList).toHaveBeenLastCalledWith('org-7');
  }
});

test('every other role is refused before anything is read', async () => {
  for (const role of ['athlete', 'parent', 'volunteer', 'staff', 'platform_owner', 'board'] as PilotRole[]) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    const response = await GET(request());
    expect([role, response.status]).toEqual([role, 403]);
  }
  expect(mockList).not.toHaveBeenCalled();
});
