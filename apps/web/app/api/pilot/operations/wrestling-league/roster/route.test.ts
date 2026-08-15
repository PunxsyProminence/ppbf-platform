import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { addLeagueRosterEntry, listLeagueRoster } from '@/src/server/pilot/wrestlingLeague';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/wrestlingLeague', () => {
  const actual = jest.requireActual('@/src/server/pilot/wrestlingLeague');
  return {
    ...actual,
    addLeagueRosterEntry: jest.fn(),
    listLeagueRoster: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAdd = addLeagueRosterEntry as jest.Mock;
const mockList = listLeagueRoster as jest.Mock;

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

const getRequest = (query: string) =>
  new NextRequest(`http://localhost/api/pilot/operations/wrestling-league/roster?${query}`);

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/operations/wrestling-league/roster', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('a coach reads the roster but cannot add to it', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  mockList.mockResolvedValue([]);

  expect((await GET(getRequest('season_id=s-1'))).status).toBe(200);
  expect((await POST(postRequest({ season_id: 's-1', athlete_id: 'ath-1' }))).status).toBeGreaterThanOrEqual(400);
  expect(mockAdd).not.toHaveBeenCalled();
});

test('a season or athlete outside the organization is a hidden not-found', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAdd.mockResolvedValue(null);

  const response = await POST(postRequest({ season_id: 's-1', athlete_id: 'ath-other-org' }));

  expect(response.status).toBe(404);
});

test('a duplicate roster add answers 409', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAdd.mockRejectedValue(new Error('LEAGUE_ROSTER_DUPLICATE_ENTRY: athlete already on this season roster'));

  const response = await POST(postRequest({ season_id: 's-1', athlete_id: 'ath-1' }));
  const payload = await response.json();

  expect(response.status).toBe(409);
  expect(payload.error).toMatch(/already on the season roster/i);
});

test('a valid add files the link under the caller', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAdd.mockResolvedValue({ entry_id: 'entry-1' });

  await POST(postRequest({ season_id: 's-1', athlete_id: 'ath-1' }));

  expect(mockAdd).toHaveBeenCalledWith({
    organizationId: 'org-1',
    seasonId: 's-1',
    athleteId: 'ath-1',
    createdByAccountId: 'acct-1',
  });
});
