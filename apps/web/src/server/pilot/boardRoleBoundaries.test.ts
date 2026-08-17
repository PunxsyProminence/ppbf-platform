import { NextRequest } from 'next/server';

import { GET as getAdminCapabilities } from '@/app/api/pilot/admin/capabilities/route';
import { POST as getAthlete } from '@/app/api/pilot/athletes/get/route';
import { GET as getComplianceViolations } from '@/app/api/pilot/compliance/violations/route';
import { GET as getEscalations } from '@/app/api/pilot/escalations/route';
import { GET as listCompetitionEntries } from '@/app/api/pilot/operations/external-competition/entries/route';
import { GET as listCompetitions } from '@/app/api/pilot/operations/external-competition/competitions/route';
import { GET as listLeagueRoster } from '@/app/api/pilot/operations/wrestling-league/roster/route';
import { GET as listLeagueSeasons } from '@/app/api/pilot/operations/wrestling-league/seasons/route';
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

jest.mock('./escalationLadder', () => ({
  listEscalations: jest.fn(),
  acknowledgeEscalation: jest.fn(),
  resolveEscalation: jest.fn(),
  detectRepeatedPatternEscalations: jest.fn(),
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
  {
    surface: 'safety escalations',
    invoke: () => getEscalations(new NextRequest(
      'http://localhost/api/pilot/escalations',
    )),
  },
  {
    // Board's window into the league is getBoardWrestlingLeagueSummary
    // (GET /api/pilot/board/wrestling-league-summary) -- organization-wide
    // counts only. LEAGUE_READ_ROLES on this route stays coach/
    // organization_admin/admin, never board.
    surface: 'wrestling league seasons',
    invoke: () => listLeagueSeasons(new NextRequest(
      'http://localhost/api/pilot/operations/wrestling-league/seasons',
    )),
  },
  {
    surface: 'wrestling league roster',
    invoke: () => listLeagueRoster(new NextRequest(
      'http://localhost/api/pilot/operations/wrestling-league/roster?season_id=season-other-org',
    )),
  },
  {
    // Board's window into external competition activity is
    // getBoardExternalCompetitionSummary (GET
    // /api/pilot/board/external-competition-summary) -- organization-wide
    // counts only. COMPETITION_READ_ROLES on this route stays coach/
    // organization_admin/admin, never board.
    surface: 'external competitions',
    invoke: () => listCompetitions(new NextRequest(
      'http://localhost/api/pilot/operations/external-competition/competitions',
    )),
  },
  {
    surface: 'external competition entries',
    invoke: () => listCompetitionEntries(new NextRequest(
      'http://localhost/api/pilot/operations/external-competition/entries?competition_id=comp-other-org',
    )),
  },
])('keeps Board denied from the $surface surface', async ({ invoke }) => {
  const response = await invoke();
  expect(response.status).toBe(403);
});
