import { NextRequest } from 'next/server';

import { GET } from './route';
import { getAthletesByOrganization, getAthletesForCoach } from '@/src/server/pilot/entities';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getReadinessBoard } from '@/src/server/pilot/readinessBoard';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/entities', () => ({
  getAthletesForCoach: jest.fn(),
  getAthletesByOrganization: jest.fn(),
}));

jest.mock('@/src/server/pilot/readinessBoard', () => {
  const actual = jest.requireActual('@/src/server/pilot/readinessBoard');
  return { ...actual, getReadinessBoard: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockForCoach = getAthletesForCoach as jest.Mock;
const mockByOrg = getAthletesByOrganization as jest.Mock;
const mockBoard = getReadinessBoard as jest.Mock;

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

const getRequest = () => new NextRequest('http://localhost/api/pilot/coach/readiness-board');

test('a coach reads through their own roster derivation, not the whole organization', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockForCoach.mockResolvedValue([{ athlete_id: 'ath-1' }, { athlete_id: 'ath-2' }]);
  mockBoard.mockResolvedValue([]);

  const response = await GET(getRequest());

  expect(response.status).toBe(200);
  expect(mockForCoach).toHaveBeenCalledWith('org-1', 'acct-1');
  expect(mockByOrg).not.toHaveBeenCalled();
  expect(mockBoard).toHaveBeenCalledWith('org-1', ['ath-1', 'ath-2']);
});

test('an admin reads the organization roster', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
  mockByOrg.mockResolvedValue([{ athlete_id: 'ath-1' }]);
  mockBoard.mockResolvedValue([{ athlete_id: 'ath-1', status: 'GREEN', score: 8, measured_at: 'now' }]);

  const payload = await (await GET(getRequest())).json();

  expect(mockByOrg).toHaveBeenCalledWith('org-1');
  expect(payload.items).toHaveLength(1);
});

test('a parent or athlete gets no readiness board at all', async () => {
  for (const role of ['parent', 'athlete', 'platform_owner'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(getRequest())).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockBoard).not.toHaveBeenCalled();
});
