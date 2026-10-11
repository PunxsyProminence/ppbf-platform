import { NextRequest } from 'next/server';

import { DELETE, GET } from './route';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
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

function as(role: PilotPrincipal['role']): PilotPrincipal {
  return {
    accountId: 'account-1',
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
  };
}

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

  // The gym's job list is gym work: the platform owner is refused on both
  // verbs before the queue is read or changed (OD-2026-10-10-004 ruling 3).
  test.each([
    ['the list', () => GET(new NextRequest('http://localhost/api/pilot/shadow/jobs'))],
    ['the list with a limit', () => GET(new NextRequest('http://localhost/api/pilot/shadow/jobs?limit=5'))],
    ['a cancellation', () => DELETE(new NextRequest(
      'http://localhost/api/pilot/shadow/jobs?jobId=7339777f-97cc-4c64-aa87-56ea042d06ac',
      { method: 'DELETE' },
    ))],
    ['a cancellation naming no job', () => DELETE(new NextRequest(
      'http://localhost/api/pilot/shadow/jobs',
      { method: 'DELETE' },
    ))],
  ])('refuses the platform owner %s, and touches no job', async (_label, call) => {
    mockRequirePrincipal.mockResolvedValue(as('platform_owner'));

    const response = await call();

    expect(response.status).toBe(403);
    expect(mockGetJobs).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
  });

  test.each(['organization_admin', 'admin', 'coach'] as const)('%s still lists jobs', async (role) => {
    mockRequirePrincipal.mockResolvedValue(as(role));

    const response = await GET(new NextRequest('http://localhost/api/pilot/shadow/jobs?limit=5'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, jobs: [] });
    expect(mockGetJobs).toHaveBeenCalledWith(as(role), 5);
  });

  test.each(['organization_admin', 'admin'] as const)('%s still cancels a pending job', async (role) => {
    mockRequirePrincipal.mockResolvedValue(as(role));

    const response = await DELETE(new NextRequest(
      'http://localhost/api/pilot/shadow/jobs?jobId=7339777f-97cc-4c64-aa87-56ea042d06ac',
      { method: 'DELETE' },
    ));

    expect(response.status).toBe(200);
    expect(mockCancel).toHaveBeenCalledWith('7339777f-97cc-4c64-aa87-56ea042d06ac', as(role));
  });

  test('a coach still cannot cancel', async () => {
    mockRequirePrincipal.mockResolvedValue(as('coach'));

    const response = await DELETE(new NextRequest(
      'http://localhost/api/pilot/shadow/jobs?jobId=7339777f-97cc-4c64-aa87-56ea042d06ac',
      { method: 'DELETE' },
    ));

    expect(response.status).toBe(403);
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
