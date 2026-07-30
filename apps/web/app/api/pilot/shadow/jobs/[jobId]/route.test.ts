import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getJobStatusForActor } from '@/src/server/pilot/shadowJobQueue';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowJobQueue', () => ({
  getJobStatusForActor: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockGetJobStatus = jest.mocked(getJobStatusForActor);
const jobId = '7339777f-97cc-4c64-aa87-56ea042d06ac';

test('denies a Board user status access to a job created under a prior role', async () => {
  mockRequirePrincipal.mockResolvedValue({
    accountId: 'account-1',
    role: 'board',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
  });

  const response = await GET(
    new NextRequest(`http://localhost/api/pilot/shadow/jobs/${jobId}`),
    { params: Promise.resolve({ jobId }) },
  );

  expect(response.status).toBe(403);
  expect(mockGetJobStatus).not.toHaveBeenCalled();
});
