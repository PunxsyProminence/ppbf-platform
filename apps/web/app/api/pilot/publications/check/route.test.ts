import { NextRequest } from 'next/server';

import { POST } from './route';
import { recordComplianceCheck, updatePublicationStatus } from '@/src/server/pilot/publication';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/publication', () => ({
  recordComplianceCheck: jest.fn(),
  updatePublicationStatus: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockRecordCheck = recordComplianceCheck as jest.Mock;
const mockUpdateStatus = updatePublicationStatus as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'admin-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/publications/check', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const checkRow = { check_id: 'check-1', publication_id: 'pub-1', check_type: 'compliance', check_status: 'passed', details: '' };

// This route is the only way a publication reaches 'approved' or 'rejected'.
// If the mapping below breaks, the coach's Publish control becomes unreachable
// again and nothing in the publish path would notice.
describe('POST /api/pilot/publications/check', () => {
  test.each(['coach', 'athlete', 'parent', 'volunteer', 'staff', 'board'] as const)(
    '%s cannot record a compliance check',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));
      const res = await POST(postRequest({ publication_id: 'pub-1', check_type: 'compliance', check_status: 'passed' }));
      expect(res.status).toBe(403);
      expect(mockRecordCheck).not.toHaveBeenCalled();
    },
  );

  test('a passing check approves the publication and records the approver', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'admin-1' }));
    mockRecordCheck.mockResolvedValueOnce(checkRow);

    const res = await POST(postRequest({ publication_id: 'pub-1', check_type: 'compliance', check_status: 'passed' }));

    expect(res.status).toBe(201);
    expect(mockUpdateStatus).toHaveBeenCalledWith('org-1', 'pub-1', 'approved', 'passed', 'admin-1');
    expect(await res.json()).toEqual(expect.objectContaining({
      publication_status: 'approved',
      compliance_check_status: 'passed',
    }));
  });

  test('a failing check rejects the publication', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockRecordCheck.mockResolvedValueOnce({ ...checkRow, check_status: 'failed' });

    await POST(postRequest({ publication_id: 'pub-1', check_type: 'safety', check_status: 'failed' }));

    expect(mockUpdateStatus).toHaveBeenCalledWith('org-1', 'pub-1', 'rejected', 'failed', undefined);
  });

  test.each([
    ['manual_review', 'manual_review'],
    ['warning', 'pending'],
  ])('a %s check leaves the publication in review, never approved', async (checkStatus, complianceStatus) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockRecordCheck.mockResolvedValueOnce({ ...checkRow, check_status: checkStatus });

    await POST(postRequest({ publication_id: 'pub-1', check_type: 'consent', check_status: checkStatus }));

    expect(mockUpdateStatus).toHaveBeenCalledWith('org-1', 'pub-1', 'pending_review', complianceStatus, undefined);
  });

  test('a check against another organization publication returns hidden not-found and changes no status', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockRecordCheck.mockResolvedValueOnce(null);

    const res = await POST(postRequest({ publication_id: 'pub-other-gym', check_type: 'compliance', check_status: 'passed' }));

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });

  test.each([
    { check_type: 'vibes', check_status: 'passed' },
    { check_type: 'compliance', check_status: 'approved' },
  ])('a value outside the stored vocabulary is rejected before anything is written', async (body) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));

    const res = await POST(postRequest({ publication_id: 'pub-1', ...body }));

    expect(res.status).toBe(400);
    expect(mockRecordCheck).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
  });
});
