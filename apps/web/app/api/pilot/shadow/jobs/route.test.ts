import { NextRequest } from 'next/server';

import { DELETE, GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { cancelJobForActor, getJobsForActor } from '@/src/server/pilot/shadowJobQueue';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowJobQueue', () => ({
  cancelJobForActor: jest.fn(),
  getJobsForActor: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockCancel = jest.mocked(cancelJobForActor);
const mockGetJobs = jest.mocked(getJobsForActor);

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue({
    accountId: 'account-1',
    role: 'organization_admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
  });
  mockGetJobs.mockResolvedValue([]);
  mockCancel.mockResolvedValue(true);
});

describe('SHADOW jobs collection route validation', () => {
  test('rejects a malformed list limit instead of coercing it', async () => {
    const response = await GET(new NextRequest(
      'http://localhost/api/pilot/shadow/jobs?limit=12junk',
    ));

    expect(response.status).toBe(400);
    expect(mockGetJobs).not.toHaveBeenCalled();
  });

  test('hides a malformed UUID cancellation target as not found', async () => {
    const response = await DELETE(new NextRequest(
      'http://localhost/api/pilot/shadow/jobs?jobId=not-a-uuid',
      { method: 'DELETE' },
    ));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(mockCancel).not.toHaveBeenCalled();
  });

  test('denies a Board user list and cancellation access to prior-role jobs', async () => {
    mockRequirePrincipal.mockResolvedValue({
      accountId: 'account-1',
      role: 'board',
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'ppbf_local',
    });

    const listResponse = await GET(new NextRequest(
      'http://localhost/api/pilot/shadow/jobs',
    ));
    const cancelResponse = await DELETE(new NextRequest(
      'http://localhost/api/pilot/shadow/jobs?jobId=7339777f-97cc-4c64-aa87-56ea042d06ac',
      { method: 'DELETE' },
    ));

    expect([listResponse.status, cancelResponse.status]).toEqual([403, 403]);
    expect(mockGetJobs).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
  });
});
