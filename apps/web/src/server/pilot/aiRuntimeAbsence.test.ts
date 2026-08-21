import { NextRequest } from 'next/server';

import { GET as coachIntelligenceGET } from '@/app/api/pilot/coach/intelligence/route';
import { GET as floorPlansGET } from '@/app/api/pilot/floor-plans/route';
import { GET as platformOrganizationsGET } from '@/app/api/pilot/platform/organizations/route';
import { GET as progressionAssignmentsGET } from '@/app/api/pilot/progression/assignments/route';
import { getAzureAiRuntimeConfig } from './azureAiRuntime';
import { getCoachIntelligence } from './coachIntelligence';
import { query } from './db';
import { getAthletesByOrganization } from './entities';
import { requirePrincipal } from './http';
import { getAthleteAssignments } from './progression';
import type { PilotPrincipal } from './auth';
import type { PilotRole } from './contracts';

/*
 * OPERATIONS V1 acceptance points 41 and 42, the runtime half.
 *
 * aiRuntimeIsolation.convention.test.ts already proves the STRUCTURE: no
 * core route or server module imports azureAiRuntime. That is a statement
 * about the import graph, and it is the strongest half of the guarantee --
 * but it is not the same sentence as "Platform, Admin, Coach and Athlete
 * conventional operation still functions when the AI services are gone".
 * That sentence is about behavior, and behavior is what this file runs.
 *
 * The outage is SIMULATED, not mocked away: the three AZURE_AI_* variables
 * are deleted from process.env for the duration, and the first test proves
 * the deletion actually took -- an outage the test framework quietly papered
 * over would make every assertion below vacuous. Then one representative
 * READ per role tier is driven end to end through its real handler.
 *
 * What this deliberately does NOT assert: that SHADOW fails gracefully. That
 * is its own contract, tested where SHADOW is tested. The claim here is
 * narrow and is exactly the claim the acceptance contract makes -- the
 * ordinary working surfaces do not consult the AI runtime and do not care
 * that it is absent.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

jest.mock('@/src/server/pilot/auth', () => ({
  createOrganization: jest.fn(),
}));

jest.mock('@/src/server/pilot/entities', () => ({
  getAthletesByOrganization: jest.fn(),
  getAthletesForCoach: jest.fn(),
}));

jest.mock('@/src/server/pilot/coachIntelligence', () => ({
  getCoachIntelligence: jest.fn(),
}));

jest.mock('@/src/server/pilot/progression', () => ({
  getAthleteAssignments: jest.fn(),
  assignDrill: jest.fn(),
  getProgressionGapById: jest.fn(),
}));

jest.mock('@/src/server/pilot/drills', () => ({
  DRILL_DIFFICULTIES: ['beginner', 'intermediate', 'advanced'],
  isDrillDifficulty: jest.fn(() => true),
  getDrill: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockByOrg = getAthletesByOrganization as jest.Mock;
const mockDigest = getCoachIntelligence as jest.Mock;
const mockAssignments = getAthleteAssignments as jest.Mock;

const AI_VARS = ['AZURE_AI_ENDPOINT', 'AZURE_AI_KEY', 'AZURE_AI_DEPLOYMENT_NAME', 'AZURE_AI_API_VERSION'] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const name of AI_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterAll(() => {
  for (const name of AI_VARS) {
    if (savedEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedEnv[name];
    }
  }
});

afterEach(() => {
  jest.clearAllMocks();
});

function principal(role: PilotRole, overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: `${role}-account`,
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

test('the simulated outage is real: with the AI variables gone the runtime reports itself unconfigured', () => {
  const check = getAzureAiRuntimeConfig();

  expect(check.ok).toBe(false);
  expect(check.missing.sort()).toEqual(
    ['AZURE_AI_DEPLOYMENT_NAME', 'AZURE_AI_ENDPOINT', 'AZURE_AI_KEY'],
  );
  expect(check.config).toBeUndefined();
});

test('PLATFORM: the platform owner still reads their roster of gyms', async () => {
  mockRequirePrincipal.mockResolvedValue(principal('platform_owner', { organizationId: 'platform' }));
  mockQuery.mockResolvedValue([
    { organization_id: 'gym-1', organization_name: 'Gym One', status: 'active', created_at: 'x', updated_at: 'x' },
  ]);

  const response = await platformOrganizationsGET(
    new NextRequest('http://localhost/api/pilot/platform/organizations'),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    organizations: [
      { organization_id: 'gym-1', organization_name: 'Gym One', status: 'active', created_at: 'x', updated_at: 'x' },
    ],
  });
});

test('ADMIN: an organization admin still reads the floor plans for their gym', async () => {
  mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
  mockQuery.mockResolvedValue([{ athlete_id: 'ath-1', payload: { athleteName: 'Rosa', tasks: [] } }]);

  const response = await floorPlansGET(new NextRequest('http://localhost/api/pilot/floor-plans'));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ items: [{ athleteName: 'Rosa', tasks: [] }] });
});

test('COACH: the Morning Read still assembles from the real access scope', async () => {
  mockRequirePrincipal.mockResolvedValue(principal('coach'));
  // athleteIdsForCoach is NOT mocked here -- the real union runs against the
  // mocked database, so the scope this digest is built on is the production
  // one even while the AI endpoint is gone.
  mockQuery.mockResolvedValue([{ athlete_id: 'ath-1' }]);
  mockDigest.mockResolvedValue({ stalled_gaps: [], open_escalations: [] });

  const response = await coachIntelligenceGET(
    new NextRequest('http://localhost/api/pilot/coach/intelligence'),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ stalled_gaps: [], open_escalations: [] });
  expect(mockDigest).toHaveBeenCalledWith('org-1', ['ath-1']);
  expect(mockByOrg).not.toHaveBeenCalled();
});

test('ATHLETE: an athlete still reads the work assigned to them', async () => {
  mockRequirePrincipal.mockResolvedValue(principal('athlete', { athleteId: 'ath-1' }));
  mockAssignments.mockResolvedValue([{ assignment_id: 'assignment-1', athlete_id: 'ath-1' }]);

  const response = await progressionAssignmentsGET(
    new NextRequest('http://localhost/api/pilot/progression/assignments?athlete_id=ath-1'),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    items: [{ assignment_id: 'assignment-1', athlete_id: 'ath-1' }],
  });
});
