import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  createGrantObligation,
  listGrantObligations,
  updateGrantObligationStatus,
} from '@/src/server/pilot/grantObligations';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/grantObligations', () => {
  const actual = jest.requireActual('@/src/server/pilot/grantObligations');
  return {
    ...actual,
    createGrantObligation: jest.fn(),
    listGrantObligations: jest.fn(),
    updateGrantObligationStatus: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockCreate = createGrantObligation as jest.Mock;
const mockList = listGrantObligations as jest.Mock;
const mockUpdate = updateGrantObligationStatus as jest.Mock;

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
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = (query = '') =>
  new NextRequest(`http://localhost/api/pilot/admin/grant-obligations${query ? `?${query}` : ''}`);

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/admin/grant-obligations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const patchRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/admin/grant-obligations', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const VALID_POST = {
  grant_name: 'Community Youth Grant',
  obligation_type: 'report',
  description: 'Quarterly outcomes report.',
  due_date: '2026-10-01',
};

// Funder commitments are office records: admin-only in both directions.
describe('role gating', () => {
  test.each(['coach', 'athlete', 'parent', 'board', 'volunteer'] as const)('%s is forbidden on every method', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
    expect((await POST(postRequest(VALID_POST))).status).toBeGreaterThanOrEqual(400);
    expect((await PATCH(patchRequest({ obligation_id: 'ob-1', status: 'complete' }))).status).toBeGreaterThanOrEqual(400);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test('an organization admin lists, org-scoped', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockList.mockResolvedValue([]);

    const payload = await (await GET(getRequest())).json();

    expect(mockList).toHaveBeenCalledWith('org-1', {});
    expect(payload.items).toEqual([]);
  });
});

describe('input validation', () => {
  beforeEach(() => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
  });

  test('an unknown status filter is refused rather than passed through', async () => {
    expect((await GET(getRequest('status=someday'))).status).toBeGreaterThanOrEqual(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('an unknown obligation_type is refused', async () => {
    const response = await POST(postRequest({ ...VALID_POST, obligation_type: 'party' }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('a malformed due date is refused', async () => {
    const response = await POST(postRequest({ ...VALID_POST, due_date: 'next fall' }));
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('a valid create is filed under the caller and their organization', async () => {
    mockCreate.mockResolvedValue({ obligation_id: 'ob-1' });

    await POST(postRequest({ ...VALID_POST, funder_name: 'Foundation X' }));

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      createdByAccountId: 'acct-1',
      grantName: 'Community Youth Grant',
      funderName: 'Foundation X',
      obligationType: 'report',
      dueDate: '2026-10-01',
    }));
  });

  test('a missing obligation returns 404, and an unknown status never reaches the module', async () => {
    mockUpdate.mockResolvedValue(null);

    expect((await PATCH(patchRequest({ obligation_id: 'ob-x', status: 'complete' }))).status).toBe(404);
    expect((await PATCH(patchRequest({ obligation_id: 'ob-x', status: 'someday' }))).status).toBeGreaterThanOrEqual(400);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
  });
});
