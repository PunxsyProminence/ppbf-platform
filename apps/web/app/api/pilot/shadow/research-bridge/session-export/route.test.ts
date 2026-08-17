import { NextRequest } from 'next/server';

import { GET } from './route';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { buildResearchBridgeExport } from '@/src/server/pilot/researchBridgeExport';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
}));

jest.mock('@/src/server/pilot/researchBridgeExport', () => ({
  buildResearchBridgeExport: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockQuery = jest.mocked(query);
const mockBuild = jest.mocked(buildResearchBridgeExport);

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function request() {
  return new NextRequest('http://localhost/api/pilot/shadow/research-bridge/session-export');
}

function samplePayload(marker: string) {
  return {
    schema_version: '1' as const,
    classification: 'sanitized-staging-only' as const,
    generated_at: '2026-08-17T00:00:00.000Z',
    research_needs: [],
    approved_evidence: [{ id: marker, title: marker } as never],
  };
}

beforeEach(() => {
  jest.resetAllMocks();
  mockBuild.mockImplementation(async (organizationId: string) => samplePayload(`evidence-${organizationId}`));
});

test('an organization_admin without the cross-org flag reaches only their own organization', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin', organizationId: 'org-1' }));

  const response = await GET(request());
  const json = await response.json();

  expect(response.status).toBe(200);
  expect(json.scope).toBe('organization');
  expect(json.exports).toHaveLength(1);
  expect(json.exports[0].organization_id).toBe('org-1');
  expect(mockBuild).toHaveBeenCalledWith('org-1');
  expect(mockBuild).toHaveBeenCalledTimes(1);
  // Never touches the cross-org organization listing query.
  expect(mockQuery).not.toHaveBeenCalled();
});

test('an ungranted, non-admin account cannot reach the export at all, even though it tries', async () => {
  mockRequirePrincipal.mockResolvedValue(
    principal({ role: 'coach', organizationId: 'org-1', hasMasterShadowAccess: false }),
  );

  const response = await GET(request());

  expect(response.status).toBe(403);
  expect(mockBuild).not.toHaveBeenCalled();
  expect(mockQuery).not.toHaveBeenCalled();
});

test('an ungranted organization_admin never gets the cross-org branch', async () => {
  mockRequirePrincipal.mockResolvedValue(
    principal({ role: 'organization_admin', organizationId: 'org-1', hasMasterShadowAccess: false }),
  );

  const response = await GET(request());
  const json = await response.json();

  expect(response.status).toBe(200);
  expect(json.scope).toBe('organization');
  expect(json.exports).toHaveLength(1);
  expect(mockQuery).not.toHaveBeenCalled();
});

test('a granted account reaches every organization on record', async () => {
  mockRequirePrincipal.mockResolvedValue(
    principal({ role: 'staff', organizationId: 'org-1', hasMasterShadowAccess: true }),
  );
  mockQuery.mockResolvedValueOnce([
    { organization_id: 'org-1' },
    { organization_id: 'org-2' },
    { organization_id: 'org-3' },
  ]);

  const response = await GET(request());
  const json = await response.json();

  expect(response.status).toBe(200);
  expect(json.scope).toBe('cross_organization');
  expect(json.exports.map((row: { organization_id: string }) => row.organization_id)).toEqual([
    'org-1',
    'org-2',
    'org-3',
  ]);
  expect(mockBuild).toHaveBeenCalledTimes(3);
  const [sql] = mockQuery.mock.calls[0];
  expect(sql).toContain('pilot.organizations');
  expect(sql).toContain("organization_id <> '__platform__'");
});

test('the flag takes priority: a granted organization_admin still gets the cross-org scope, not just their own org', async () => {
  mockRequirePrincipal.mockResolvedValue(
    principal({ role: 'organization_admin', organizationId: 'org-1', hasMasterShadowAccess: true }),
  );
  mockQuery.mockResolvedValueOnce([{ organization_id: 'org-1' }, { organization_id: 'org-9' }]);

  const response = await GET(request());
  const json = await response.json();

  expect(json.scope).toBe('cross_organization');
  expect(json.exports).toHaveLength(2);
});
