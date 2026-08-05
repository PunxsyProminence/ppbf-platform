import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);

function principal(role: 'admin' | 'organization_admin' | 'platform_owner' | 'coach' | 'athlete' | 'parent') {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-1',
    athleteId: role === 'athlete' ? 'athlete-1' : null,
    sessionToken: 'token',
    authProvider: 'ppbf_local' as const,
  };
}

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  jest.resetAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

test.each(['organization_admin', 'admin', 'platform_owner'] as const)(
  'allows the %s role and reports every flag off on a bare environment',
  async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal(role));
    delete process.env.PPBF_SHADOW_WORKER_ENABLED;
    delete process.env.PPBF_VIDEO_MALWARE_SCAN;
    delete process.env.PPBF_VIDEO_CONTENT_SCAN;
    delete process.env.PPBF_INTAKE_PROMOTION_ENABLED;
    delete process.env.PPBF_DURABLE_RATE_LIMIT;

    const response = await GET(new NextRequest('http://localhost/api/pilot/ops/readiness'));
    expect(response.status).toBe(200);

    const payload = await response.json();
    expect(payload.ok).toBe(true);
    expect(payload.readiness.shadowWorker.enabled).toBe(false);
    expect(payload.readiness.videoScan.enabled).toBe(false);
    expect(payload.readiness.intakePromotion.enabled).toBe(false);
    expect(payload.readiness.durableRateLimit.enabled).toBe(false);
  },
);

test.each(['coach', 'athlete', 'parent'] as const)('denies the %s role', async (role) => {
  mockRequirePrincipal.mockResolvedValueOnce(principal(role));

  const response = await GET(new NextRequest('http://localhost/api/pilot/ops/readiness'));
  expect(response.status).toBe(403);
});

test('never leaks the Postgres connection string into the response', async () => {
  mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));
  process.env.AZURE_POSTGRES_CONNECTION_STRING = 'postgres://user:supersecret@host/db';
  process.env.PPBF_DURABLE_RATE_LIMIT = 'true';

  const response = await GET(new NextRequest('http://localhost/api/pilot/ops/readiness'));
  const body = await response.text();
  expect(body).not.toContain('supersecret');
});
