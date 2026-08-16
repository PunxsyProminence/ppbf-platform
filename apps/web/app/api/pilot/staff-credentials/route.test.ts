import { NextRequest } from 'next/server';

import { GET } from './route';
import { listStaffCredentialStatus } from '@/src/server/pilot/clearanceRegister';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/clearanceRegister', () => {
  const actual = jest.requireActual('@/src/server/pilot/clearanceRegister');
  return { ...actual, listStaffCredentialStatus: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listStaffCredentialStatus as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'parent',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  } as PilotPrincipal;
}

const getReq = () => new NextRequest('http://localhost/api/pilot/staff-credentials');

describe('GET /api/pilot/staff-credentials', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    expect((await GET(getReq())).status).toBe(401);
  });

  test('every signed-in role can read it -- a parent is not refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    mockList.mockResolvedValueOnce([]);
    expect((await GET(getReq())).status).toBe(200);
  });

  test('an athlete role is also allowed, matching the wall-of-names precedent', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete' }));
    mockList.mockResolvedValueOnce([]);
    expect((await GET(getReq())).status).toBe(200);
  });

  test('groups rows by account, resolves a display name, and never carries document_ref/verification_note', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockList.mockResolvedValueOnce([
      {
        account_id: 'coach-1', role: 'coach', login_email: 'jane.okafor@example.com',
        clearance_type_id: 'ct-safesport', clearance_name: 'SafeSport Training',
        issuing_authority: 'U.S. Center for SafeSport', status: 'current', expires_on: '2027-01-01',
      },
      {
        account_id: 'coach-1', role: 'coach', login_email: 'jane.okafor@example.com',
        clearance_type_id: 'ct-cpr', clearance_name: 'CPR/First Aid',
        issuing_authority: 'American Red Cross', status: 'not_started', expires_on: null,
      },
    ]);

    const response = await GET(getReq());
    const body = (await response.json()) as { staff: Array<Record<string, unknown>> };

    expect(body.staff).toHaveLength(1);
    expect(body.staff[0]).toMatchObject({ account_id: 'coach-1', display_name: 'Jane Okafor', role: 'coach' });
    const credentials = body.staff[0].credentials as Array<Record<string, unknown>>;
    expect(credentials).toHaveLength(2);
    expect(credentials.find((c) => c.clearance_type_id === 'ct-safesport')).toMatchObject({ band: 'current' });
    expect(credentials.find((c) => c.clearance_type_id === 'ct-cpr')).toMatchObject({ band: 'missing' });

    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/document_ref/);
    expect(raw).not.toMatch(/verification_note/);
    expect(raw).not.toMatch(/verified_by_account_id/);
  });
});
