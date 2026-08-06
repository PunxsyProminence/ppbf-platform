import { POST } from './route';
import { grantCoachCoverage, isOrganizationAdminRole } from '@/src/server/pilot/access';
import { requireMicrosoftAuthenticatedPrincipal } from '@/src/server/pilot/http';
import type { NextRequest } from 'next/server';

jest.mock('@/src/server/pilot/access', () => ({
  isOrganizationAdminRole: jest.fn(),
  grantCoachCoverage: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  requireMicrosoftAuthenticatedPrincipal: jest.fn(),
  jsonError: jest.fn((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith('Forbidden') ? 403 : message.startsWith('Missing') ? 400 : 500;
    return new Response(JSON.stringify({ ok: false, error: message }), { status });
  }),
}));

const mockRequirePrincipal = requireMicrosoftAuthenticatedPrincipal as jest.Mock;
const mockIsOrgAdmin = isOrganizationAdminRole as jest.Mock;
const mockGrantCoverage = grantCoachCoverage as jest.Mock;

describe('POST /api/pilot/admin/coach-coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('refuses non-admin roles', async () => {
    mockRequirePrincipal.mockResolvedValueOnce({
      accountId: 'coach-1',
      role: 'coach',
      organizationId: 'org-1',
    });
    mockIsOrgAdmin.mockReturnValueOnce(false);

    const request = new Request('http://localhost/api/pilot/admin/coach-coverage', {
      method: 'POST',
      body: JSON.stringify({ athlete_id: 'ath-1', covering_coach_id: 'coach-sub' }),
    }) as NextRequest;

    const response = await POST(request);
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error).toContain('Forbidden');
  });

  test('grants temporary coverage for an organization admin', async () => {
    mockRequirePrincipal.mockResolvedValueOnce({
      accountId: 'admin-1',
      role: 'organization_admin',
      organizationId: 'org-1',
    });
    mockIsOrgAdmin.mockReturnValueOnce(true);
    mockGrantCoverage.mockResolvedValueOnce({
      coverageId: 'cov-123',
      expiresAt: '2026-08-07T00:00:00Z',
    });

    const request = new Request('http://localhost/api/pilot/admin/coach-coverage', {
      method: 'POST',
      body: JSON.stringify({ athlete_id: 'ath-1', covering_coach_id: 'coach-sub', ttl_hours: 48 }),
    }) as NextRequest;

    const response = await POST(request);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.coverage_id).toBe('cov-123');
    expect(mockGrantCoverage).toHaveBeenCalledWith({
      organizationId: 'org-1',
      athleteId: 'ath-1',
      coveringCoachId: 'coach-sub',
      grantedByAccountId: 'admin-1',
      ttlHours: 48,
    });
  });

  test('rejects missing parameters', async () => {
    mockRequirePrincipal.mockResolvedValueOnce({
      accountId: 'admin-1',
      role: 'organization_admin',
      organizationId: 'org-1',
    });
    mockIsOrgAdmin.mockReturnValueOnce(true);

    const request = new Request('http://localhost/api/pilot/admin/coach-coverage', {
      method: 'POST',
      body: JSON.stringify({ athlete_id: 'ath-1' }),
    }) as NextRequest;

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain('Missing');
  });
});
