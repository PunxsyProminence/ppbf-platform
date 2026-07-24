import { NextRequest } from 'next/server';

import { GET as getAdminCapabilities } from '@/app/api/pilot/admin/capabilities/route';
import { POST as getAthlete } from '@/app/api/pilot/athletes/get/route';
import { GET as getComplianceViolations } from '@/app/api/pilot/compliance/violations/route';
import { GET as listGoals } from '@/app/api/pilot/goals/list/route';
import { POST as listIntakeReviews } from '@/app/api/pilot/intake/review-queue/route';
import { GET as getScheduler } from '@/app/api/pilot/scheduler/route';
import { GET as listSessions } from '@/app/api/pilot/sessions/list/route';
import { requirePrincipal } from './http';

jest.mock('./http', () => {
  const actual = jest.requireActual('./http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('./entities', () => ({
  getAthleteById: jest.fn(),
  getGoalsByAthlete: jest.fn(),
  getSessionsByAthlete: jest.fn(),
}));

jest.mock('./intake', () => ({
  listReviewQueue: jest.fn(),
}));

jest.mock('./compliance', () => ({
  createComplianceViolation: jest.fn(),
  getComplianceRuleById: jest.fn(),
  getOrganizationViolations: jest.fn(),
}));

jest.mock('./videoSessions', () => ({
  getVideoSessionById: jest.fn(),
}));

jest.mock('./db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);

beforeEach(() => {
  jest.resetAllMocks();
  mockRequirePrincipal.mockResolvedValue({
    accountId: 'board-account',
    role: 'board',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
  });
});

test.each([
  {
    surface: 'athlete record',
    invoke: () => getAthlete(new NextRequest(
      'http://localhost/api/pilot/athletes/get',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ athlete_id: 'athlete-other-org' }),
      },
    )),
  },
  {
    surface: 'goal records',
    invoke: () => listGoals(new NextRequest(
      'http://localhost/api/pilot/goals/list?athlete_id=athlete-other-org',
    )),
  },
  {
    surface: 'training sessions',
    invoke: () => listSessions(new NextRequest(
      'http://localhost/api/pilot/sessions/list?athlete_id=athlete-other-org',
    )),
  },
  {
    surface: 'intake review queue',
    invoke: () => listIntakeReviews(new NextRequest(
      'http://localhost/api/pilot/intake/review-queue',
      { method: 'POST' },
    )),
  },
  {
    surface: 'admin capabilities',
    invoke: () => getAdminCapabilities(new NextRequest(
      'http://localhost/api/pilot/admin/capabilities',
    )),
  },
  {
    surface: 'safety/compliance violations',
    invoke: () => getComplianceViolations(new NextRequest(
      'http://localhost/api/pilot/compliance/violations',
    )),
  },
  {
    surface: 'athlete scheduler',
    invoke: () => getScheduler(new NextRequest(
      'http://localhost/api/pilot/scheduler',
    )),
  },
])('keeps Board denied from the $surface surface', async ({ invoke }) => {
  const response = await invoke();
  expect(response.status).toBe(403);
});
