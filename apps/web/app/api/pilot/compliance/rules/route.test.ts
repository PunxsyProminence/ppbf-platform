import { NextRequest } from 'next/server';

import { GET } from './route';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

// The rules read behind Escalate to Compliance. Before it existed the only
// rules read was the board's, so nobody who may file a violation could learn
// a rule id to file one under.

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;

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
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function getRequest() {
  return new NextRequest('http://localhost/api/pilot/compliance/rules');
}

const RULE = {
  rule_id: 'rule_safety_org-1_physical_injury',
  rule_name: 'Physical Injury Prevention',
  rule_category: 'safety',
  severity: 'critical',
  escalation_level: 'admin',
  active_flag: true,
};

describe('GET /api/pilot/compliance/rules', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
  });

  // Exactly the roles the violations POST lets file, and no wider. The
  // platform owner and the board are refused before any query runs.
  test.each(['platform_owner', 'board', 'athlete', 'parent', 'volunteer'])(
    '403 for %s, before any read',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: role as PilotPrincipal['role'] }));
      const res = await GET(getRequest());
      expect(res.status).toBe(403);
      expect(mockQuery).not.toHaveBeenCalled();
    },
  );

  test.each(['coach', 'organization_admin', 'admin'])(
    '%s reads the active rules of its own organization only',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: role as PilotPrincipal['role'] }));
      mockQuery.mockResolvedValueOnce([RULE]);

      const res = await GET(getRequest());

      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(await res.json()).toEqual({ ok: true, rules: [RULE] });
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain('organization_id = $1');
      expect(sql).toContain('active_flag = true');
      expect(params[0]).toBe('org-1');
    },
  );
});
