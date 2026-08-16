import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  createCompetition,
  listCompetitions,
  setCompetitionStatus,
} from '@/src/server/pilot/externalCompetition';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/externalCompetition', () => {
  const actual = jest.requireActual('@/src/server/pilot/externalCompetition');
  return {
    ...actual,
    createCompetition: jest.fn(),
    listCompetitions: jest.fn(),
    setCompetitionStatus: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockCreate = createCompetition as jest.Mock;
const mockList = listCompetitions as jest.Mock;
const mockSetStatus = setCompetitionStatus as jest.Mock;

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
  new NextRequest('http://localhost/api/pilot/operations/external-competition/competitions');

const bodyRequest = (method: 'POST' | 'PATCH', body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/operations/external-competition/competitions', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('a coach reads competitions but cannot create or advance them', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  mockList.mockResolvedValue([]);

  expect((await GET(getRequest())).status).toBe(200);
  expect((await POST(bodyRequest('POST', { competition_name: 'C', competition_date: '2026-12-05' }))).status).toBeGreaterThanOrEqual(400);
  expect((await PATCH(bodyRequest('PATCH', { competition_id: 'c-1', status: 'completed' }))).status).toBeGreaterThanOrEqual(400);
  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockSetStatus).not.toHaveBeenCalled();
});

test('platform_owner is refused the read -- the surface joins athlete names elsewhere', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'platform_owner' }));

  expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
  expect(mockList).not.toHaveBeenCalled();
});

test('a competition is filed under the caller organization and account', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockCreate.mockResolvedValue({ competition_id: 'c-1' });

  const response = await POST(bodyRequest('POST', {
    competition_name: '  Regional Open  ',
    competition_date: '2026-12-05',
    sanctioning_body: 'USA Boxing',
  }));

  expect(response.status).toBe(200);
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    organizationId: 'org-1',
    competitionName: 'Regional Open',
    competitionDate: '2026-12-05',
    sanctioningBody: 'USA Boxing',
    createdByAccountId: 'acct-1',
  }));
});

test('a malformed date is refused before any write', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  const response = await POST(bodyRequest('POST', { competition_name: 'C', competition_date: 'soon' }));

  expect(response.status).toBe(400);
  expect(mockCreate).not.toHaveBeenCalled();
});

test('a competition outside the organization is a hidden not-found on status change', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockSetStatus.mockResolvedValue(null);

  const response = await PATCH(bodyRequest('PATCH', { competition_id: 'c-other-org', status: 'completed' }));

  expect(response.status).toBe(404);
});

test('an unknown status is a 400, not a transition attempt', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  const response = await PATCH(bodyRequest('PATCH', { competition_id: 'c-1', status: 'archived' }));

  expect(response.status).toBe(400);
  expect(mockSetStatus).not.toHaveBeenCalled();
});
