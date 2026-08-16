import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listCueLibrary } from '@/src/server/pilot/drillLibraryV3';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/drillLibraryV3', () => {
  const actual = jest.requireActual('@/src/server/pilot/drillLibraryV3');
  return { ...actual, listCueLibrary: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listCueLibrary as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = (query = '') =>
  new NextRequest(`http://localhost/api/pilot/coach/cue-library${query ? `?${query}` : ''}`);

test('the read is scoped to the caller organization with the filters passed through', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockList.mockResolvedValue([]);

  const response = await GET(getRequest('focus_type=external&search=floor'));

  expect(response.status).toBe(200);
  expect(mockList).toHaveBeenCalledWith('org-1', { focusType: 'external', search: 'floor' });
});

test('an unknown focus_type is a 400, not a query', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await GET(getRequest('focus_type=telepathic'))).status).toBe(400);
  expect(mockList).not.toHaveBeenCalled();
});

test('an unauthenticated caller is refused', async () => {
  mockRequirePrincipal.mockRejectedValue(Object.assign(new Error('Unauthorized'), { status: 401 }));

  expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
  expect(mockList).not.toHaveBeenCalled();
});
