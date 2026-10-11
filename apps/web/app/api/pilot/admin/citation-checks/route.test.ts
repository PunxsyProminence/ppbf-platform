// Citation checks are read against the caller's own gym's sources, so this is
// gym work: the gym's admin may, the platform owner may not, on every view
// (OD-2026-10-10-004 ruling 3), as on the retraction-checks twin. These tests
// show the route's list decides before any domain function runs.

import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  getSourceCitationStatus,
  getSourcesNeedingCitationCheck,
  listSourceCitationChecks,
} from '@/src/server/pilot/sourceCitationChecks';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/sourceCitationChecks', () => ({
  getSourceCitationStatus: jest.fn(),
  getSourcesNeedingCitationCheck: jest.fn(),
  listSourceCitationChecks: jest.fn(),
}));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockStatus = jest.mocked(getSourceCitationStatus);
const mockQueue = jest.mocked(getSourcesNeedingCitationCheck);
const mockChecks = jest.mocked(listSourceCitationChecks);

const URL_BASE = 'http://localhost/api/pilot/admin/citation-checks';

const VIEWS: Array<[string, string]> = [
  ['the status view', URL_BASE],
  ['the status view filtered by signal', `${URL_BASE}?review_signal=needs_adjudication`],
  ['the recheck queue', `${URL_BASE}?view=queue`],
  ['one source\'s checks', `${URL_BASE}?source_id=src-1`],
];

function as(role: string) {
  mockPrincipal.mockResolvedValue({ accountId: `${role}-1`, organizationId: 'org-1', role } as never);
}

function expectNothingRead() {
  expect(mockStatus).not.toHaveBeenCalled();
  expect(mockQueue).not.toHaveBeenCalled();
  expect(mockChecks).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.resetAllMocks();
  mockStatus.mockResolvedValue([] as never);
  mockQueue.mockResolvedValue([] as never);
  mockChecks.mockResolvedValue([] as never);
});

describe.each(VIEWS)('GET %s', (_label, url) => {
  test('refuses the platform owner, and reads nothing', async () => {
    as('platform_owner');

    const response = await GET(new NextRequest(url));

    expect(response.status).toBe(403);
    expectNothingRead();
  });

  test.each(['organization_admin', 'admin'])('%s reads it for its own gym', async (role) => {
    as(role);

    const response = await GET(new NextRequest(url));

    expect(response.status).toBe(200);
    const read = [...mockStatus.mock.calls, ...mockQueue.mock.calls, ...mockChecks.mock.calls];
    expect(read).toHaveLength(1);
    expect(read[0][0]).toBe('org-1');
  });

  test.each(['coach', 'athlete', 'parent', 'board', 'staff', 'volunteer'])(
    '%s is refused, as before',
    async (role) => {
      as(role);

      expect((await GET(new NextRequest(url))).status).toBe(403);
      expectNothingRead();
    },
  );
});

test('each view reaches its own reader', async () => {
  as('organization_admin');

  await GET(new NextRequest(URL_BASE));
  await GET(new NextRequest(`${URL_BASE}?view=queue&limit=25`));
  await GET(new NextRequest(`${URL_BASE}?source_id=src-1`));

  expect(mockStatus).toHaveBeenCalledWith('org-1', { reviewSignal: undefined });
  expect(mockQueue).toHaveBeenCalledWith('org-1', 25);
  expect(mockChecks).toHaveBeenCalledWith('org-1', 'src-1');
});
