import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { createLeagueEvent, listLeagueEvents } from '@/src/server/pilot/wrestlingLeague';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/wrestlingLeague', () => {
  const actual = jest.requireActual('@/src/server/pilot/wrestlingLeague');
  return {
    ...actual,
    createLeagueEvent: jest.fn(),
    listLeagueEvents: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockCreate = createLeagueEvent as jest.Mock;
const mockList = listLeagueEvents as jest.Mock;

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
  new NextRequest(`http://localhost/api/pilot/operations/wrestling-league/events?${query}`);

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/operations/wrestling-league/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('the list is scoped to the caller organization', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  mockList.mockResolvedValue([]);

  const response = await GET(getRequest('season_id=s-1'));

  expect(response.status).toBe(200);
  expect(mockList).toHaveBeenCalledWith('org-1', 's-1');
});

test('a missing season_id is a 400, not an unscoped read', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));

  expect((await GET(getRequest(''))).status).toBe(400);
  expect(mockList).not.toHaveBeenCalled();
});

test('a coach cannot create an event', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));

  const response = await POST(postRequest({ season_id: 's-1', event_name: 'Duals', event_date: '2026-11-08' }));

  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(mockCreate).not.toHaveBeenCalled();
});

test('a season from another organization is a hidden not-found, not an event', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockCreate.mockResolvedValue(null);

  const response = await POST(postRequest({ season_id: 's-other-org', event_name: 'Duals', event_date: '2026-11-08' }));

  expect(response.status).toBe(404);
});

test('a valid event is filed under the caller', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockCreate.mockResolvedValue({ event_id: 'e-1' });

  await POST(postRequest({ season_id: 's-1', event_name: 'Opening Duals', event_date: '2026-11-08', location: 'Main Gym' }));

  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    organizationId: 'org-1',
    seasonId: 's-1',
    eventName: 'Opening Duals',
    eventDate: '2026-11-08',
    createdByAccountId: 'acct-1',
  }));
});
