import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  createLeagueSeason,
  listLeagueSeasons,
  setLeagueSeasonStatus,
} from '@/src/server/pilot/wrestlingLeague';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/wrestlingLeague', () => {
  const actual = jest.requireActual('@/src/server/pilot/wrestlingLeague');
  return {
    ...actual,
    createLeagueSeason: jest.fn(),
    listLeagueSeasons: jest.fn(),
    setLeagueSeasonStatus: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockCreate = createLeagueSeason as jest.Mock;
const mockList = listLeagueSeasons as jest.Mock;
const mockSetStatus = setLeagueSeasonStatus as jest.Mock;

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

const getRequest = () =>
  new NextRequest('http://localhost/api/pilot/operations/wrestling-league/seasons');

const bodyRequest = (method: 'POST' | 'PATCH', body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/operations/wrestling-league/seasons', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('a coach reads seasons but cannot create or advance them', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  mockList.mockResolvedValue([]);

  expect((await GET(getRequest())).status).toBe(200);
  expect((await POST(bodyRequest('POST', { season_name: 'S', starts_on: '2026-11-01' }))).status).toBeGreaterThanOrEqual(400);
  expect((await PATCH(bodyRequest('PATCH', { season_id: 's-1', status: 'active' }))).status).toBeGreaterThanOrEqual(400);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockSetStatus).not.toHaveBeenCalled();
});

test('platform_owner is refused the read -- the surface joins athlete names elsewhere', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'platform_owner' }));

  expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
  expect(mockList).not.toHaveBeenCalled();
});

test('a season is filed under the caller organization and account', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockCreate.mockResolvedValue({ season_id: 's-1' });

  const response = await POST(bodyRequest('POST', {
    season_name: '  Winter League  ',
    starts_on: '2026-11-01',
    ends_on: '',
  }));

  expect(response.status).toBe(200);
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    organizationId: 'org-1',
    seasonName: 'Winter League',
    startsOn: '2026-11-01',
    endsOn: null,
    createdByAccountId: 'acct-1',
  }));
});

test('an end date before the start is refused before any write', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  const response = await POST(bodyRequest('POST', {
    season_name: 'Backwards',
    starts_on: '2026-11-01',
    ends_on: '2026-10-01',
  }));

  expect(response.status).toBe(400);
  expect(mockCreate).not.toHaveBeenCalled();
});

test('a season outside the organization is a hidden not-found on status change', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockSetStatus.mockResolvedValue(null);

  const response = await PATCH(bodyRequest('PATCH', { season_id: 's-other-org', status: 'active' }));

  expect(response.status).toBe(404);
});

test('an unknown status is a 400, not a transition attempt', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  const response = await PATCH(bodyRequest('PATCH', { season_id: 's-1', status: 'archived' }));

  expect(response.status).toBe(400);
  expect(mockSetStatus).not.toHaveBeenCalled();
});
