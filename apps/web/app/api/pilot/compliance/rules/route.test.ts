import { NextRequest } from 'next/server';

import { GET } from './route';
import { getComplianceRulesByCategory } from '@/src/server/pilot/compliance';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/compliance', () => ({
  getComplianceRulesByCategory: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockRules = getComplianceRulesByCategory as jest.Mock;

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

const getRequest = () => new NextRequest('http://localhost/api/pilot/compliance/rules');

test('a coach reads their own organization\'s active rules', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockRules.mockResolvedValue([{ rule_id: 'rule-1', rule_name: 'Proper Technique & Form' }]);

  const response = await GET(getRequest());

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    rules: [{ rule_id: 'rule-1', rule_name: 'Proper Technique & Form' }],
  });
  expect(mockRules).toHaveBeenCalledWith('org-1');
});

test('an admin can also read rules', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'admin' }));
  mockRules.mockResolvedValue([]);

  expect((await GET(getRequest())).status).toBe(200);
});

test('parents, athletes, and board are refused -- this is a coach/admin filing surface', async () => {
  for (const role of ['parent', 'athlete', 'board', 'platform_owner'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockRules).not.toHaveBeenCalled();
});
