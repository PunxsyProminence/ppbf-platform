import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { addCompetitionEntry, listCompetitionEntries } from '@/src/server/pilot/externalCompetition';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/externalCompetition', () => {
  const actual = jest.requireActual('@/src/server/pilot/externalCompetition');
  return {
    ...actual,
    addCompetitionEntry: jest.fn(),
    listCompetitionEntries: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAdd = addCompetitionEntry as jest.Mock;
const mockList = listCompetitionEntries as jest.Mock;

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
  new NextRequest(`http://localhost/api/pilot/operations/external-competition/entries?${query}`);

const postRequest = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/operations/external-competition/entries', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('a coach reads entries but cannot add one', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  mockList.mockResolvedValue([]);

  expect((await GET(getRequest('competition_id=c-1'))).status).toBe(200);
  expect(mockList).toHaveBeenCalledWith('org-1', 'c-1');
  expect((await POST(postRequest({ competition_id: 'c-1', athlete_id: 'ath-1' }))).status).toBeGreaterThanOrEqual(400);
  expect(mockAdd).not.toHaveBeenCalled();
});

test('a missing competition_id is a 400, not an unscoped read', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));

  expect((await GET(getRequest(''))).status).toBe(400);
  expect(mockList).not.toHaveBeenCalled();
});

test('a competition or athlete outside the organization is a hidden not-found', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAdd.mockResolvedValue(null);

  const response = await POST(postRequest({ competition_id: 'c-1', athlete_id: 'ath-other-org' }));

  expect(response.status).toBe(404);
});

test('a duplicate entry answers 409', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAdd.mockRejectedValue(new Error('COMPETITION_DUPLICATE_ENTRY: athlete already entered in this competition'));

  const response = await POST(postRequest({ competition_id: 'c-1', athlete_id: 'ath-1' }));
  const payload = await response.json();

  expect(response.status).toBe(409);
  expect(payload.error).toMatch(/already entered/i);
});

test('a valid entry files the link under the caller', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAdd.mockResolvedValue({ entry_id: 'entry-1' });

  await POST(postRequest({ competition_id: 'c-1', athlete_id: 'ath-1' }));

  expect(mockAdd).toHaveBeenCalledWith({
    organizationId: 'org-1',
    competitionId: 'c-1',
    athleteId: 'ath-1',
    createdByAccountId: 'acct-1',
  });
});
