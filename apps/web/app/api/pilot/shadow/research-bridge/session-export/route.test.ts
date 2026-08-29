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

const ORIGINAL_ENV = process.env;

// The environment this route is PERMITTED to run in, which is the same fence
// its Azure-AD sibling at ../export holds: the export switched on, the
// deployment declaring itself staging, and the request arriving on the
// declared host. Every test below that exercises the export itself starts
// from a permitting environment, and the fenced tests take one condition away
// at a time -- so a test that passes because the fence let it through cannot
// be confused with one that passes because there is no fence.
function permitTheExport() {
  process.env.RESEARCH_BRIDGE_EXPORT_ENABLED = 'true';
  process.env.RESEARCH_BRIDGE_EXPORT_ENVIRONMENT = 'staging';
  process.env.RESEARCH_BRIDGE_EXPORT_ALLOWED_HOST = 'localhost';
}

beforeEach(() => {
  jest.resetAllMocks();
  process.env = { ...ORIGINAL_ENV };
  permitTheExport();
  mockBuild.mockImplementation(async (organizationId: string) => samplePayload(`evidence-${organizationId}`));
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

// ---------------------------------------------------------------------------
// The environment fence
//
// This route serves the SAME payload as the Azure-AD service-account export at
// ../export -- classification 'sanitized-staging-only' -- and until now held
// none of that route's three environment conditions, so a production
// deployment served it to any session that satisfied the role branches below.
// ---------------------------------------------------------------------------

describe('the environment fence', () => {
  test.each([
    ['the export is not switched on', () => { delete process.env.RESEARCH_BRIDGE_EXPORT_ENABLED; }],
    ['the export is switched off explicitly', () => { process.env.RESEARCH_BRIDGE_EXPORT_ENABLED = 'false'; }],
    ['the deployment is not staging', () => { process.env.RESEARCH_BRIDGE_EXPORT_ENVIRONMENT = 'production'; }],
    ['no allowed host is declared', () => { delete process.env.RESEARCH_BRIDGE_EXPORT_ALLOWED_HOST; }],
    ['the request arrived on some other host', () => { process.env.RESEARCH_BRIDGE_EXPORT_ALLOWED_HOST = 'app-ppbf.example.test'; }],
  ])('returns 404 and reaches nothing when %s', async (_condition, breakTheFence) => {
    breakTheFence();
    mockRequirePrincipal.mockResolvedValue(
      principal({ role: 'organization_admin', organizationId: 'org-1', hasMasterShadowAccess: true }),
    );

    const response = await GET(request());
    const json = await response.json();

    // 404, not 403: the same answer ../export gives, and the same answer a
    // route that does not exist gives.
    expect(response.status).toBe(404);
    expect(json).toEqual({ ok: false, error: 'Research bridge export is unavailable' });
    // Fenced BEFORE the session is resolved, so a fenced deployment does no
    // authentication work and reads no organization row on this path at all --
    // and a caller who does hold the cross-organization flag gets exactly what
    // a stranger gets.
    expect(mockRequirePrincipal).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockBuild).not.toHaveBeenCalled();
  });

  test('a permitting environment lets a legitimate caller through', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin', organizationId: 'org-1' }));

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mockBuild).toHaveBeenCalledWith('org-1');
  });

  test('an x-forwarded-host that is not the declared host is fenced out', async () => {
    // Behind a proxy the declared host arrives in x-forwarded-host, and
    // resolveResearchBridgeRequestHost reads it. Asserted so the fence cannot
    // be satisfied by the internal origin the request happens to land on.
    process.env.RESEARCH_BRIDGE_EXPORT_ALLOWED_HOST = 'app-ppbf-staging.example.test';
    const proxied = new NextRequest(
      'http://internal.localhost/api/pilot/shadow/research-bridge/session-export',
      { headers: { 'x-forwarded-host': 'attacker.example.test' } },
    );

    const response = await GET(proxied);

    expect(response.status).toBe(404);
    expect(mockRequirePrincipal).not.toHaveBeenCalled();
  });
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
