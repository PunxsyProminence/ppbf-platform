import { NextRequest } from 'next/server';

import { GET as coachIntelligenceGET } from '@/app/api/pilot/coach/intelligence/route';
import { GET as floorPlansGET } from '@/app/api/pilot/floor-plans/route';
import { GET as platformOrganizationsGET } from '@/app/api/pilot/platform/organizations/route';
import { GET as progressionAssignmentsGET } from '@/app/api/pilot/progression/assignments/route';
import { getAzureAiRuntimeConfig } from '@/src/server/pilot/azureAiRuntime';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';

/*
 * OPERATIONS V1 acceptance points 41 and 42, the RUNTIME half.
 *
 * TWO GUARDS, AND NEITHER IS SUFFICIENT ALONE.
 *
 *   * aiRuntimeIsolation.convention.test.ts is the STRUCTURAL guard: it
 *     sweeps app/api and src/server and proves that no core route or server
 *     module imports azureAiRuntime, in any import shape. That is a fact
 *     about the import graph, and it is the broader of the two -- it catches
 *     a new dependency the day it is written, in a file this test has never
 *     heard of.
 *   * THIS file is the BEHAVIOURAL guard: it removes the AI configuration
 *     from the environment and then runs the real work. An import-graph
 *     sweep cannot see a module that reads process.env.AZURE_AI_KEY
 *     directly, nor one that reaches an AI service through a helper whose
 *     name the sweep's regex does not match.
 *
 * Together they are what makes "Platform, Admin, Coach and Athlete
 * conventional operation still functions without the AI services" an honest
 * sentence. Either alone leaves a hole the other covers.
 *
 * WHAT IS MOCKED, AND WHY THE LIST IS THIS SHORT.
 *
 * Exactly two seams: the DATABASE (db) and PRINCIPAL RESOLUTION
 * (requirePrincipal). Both are infrastructure this sandbox does not have --
 * there is no Postgres to read and no session cookie to resolve. Nothing
 * else is stubbed, and in particular no business function is.
 *
 * That constraint is the entire point of the file, and it was learned the
 * hard way. An earlier version of this test mocked getCoachIntelligence and
 * getAthleteAssignments, which meant it proved only that the ROUTE
 * ORCHESTRATION survived an outage. Had either of those functions grown an
 * AI dependency or a direct env read, this suite would have stayed green
 * while points 41 and 42 quietly became false. So the real
 * getCoachIntelligence runs here -- all eight of its reads, including the
 * two it delegates to listEscalations and getPerformanceRollup -- the real
 * getAthleteAssignments runs here, and the real athleteIdsForCoach computes
 * the scope the digest is built on. All of them are SQL-only, so holding the
 * database still is enough to drive the genuine article.
 *
 * The assertions are therefore "it returned its normal answer", never "a
 * mock was called": a call count would be back to testing the wiring.
 *
 * Every jest.mock specifier below is the same '@/src/server/pilot/...' form
 * the symbols are imported by, so the module instance this file configures
 * is provably the one the handlers resolve. Mixing '@/...' in the mock with
 * './...' in the import leaves that to Jest's resolver to make true by
 * coincidence.
 *
 * WHAT THIS DELIBERATELY DOES NOT ASSERT: that SHADOW degrades gracefully.
 * That is SHADOW's own contract, tested where SHADOW is tested. The claim
 * here is exactly the claim the acceptance contract makes and no wider --
 * the ordinary working surfaces do not consult the AI runtime and do not
 * care that it is absent.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  withTransaction: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

/**
 * Every AZURE_AI_* variable, not merely the three the config resolver
 * REQUIRES. AZURE_AI_API_VERSION is optional and falls back to a default, so
 * leaving it set would be leaving one piece of AI configuration standing in
 * an outage this file claims is total.
 */
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

/**
 * Answer the database by what was ASKED, not by call order.
 *
 * The real functions under test fan out -- getCoachIntelligence issues eight
 * reads through one Promise.all -- so a queue of mockResolvedValueOnce would
 * pin this file to an ordering the production code is free to change.
 * Matching on the SQL lets every read this test does not care about return
 * an empty result, which is the honest answer for a gym with no rows and is
 * enough for the real code to assemble its real output.
 */
function databaseAnswers(routes: ReadonlyArray<readonly [string, unknown[]]>): void {
  mockQuery.mockImplementation(async (sql: string) => {
    for (const [needle, rows] of routes) {
      if (sql.includes(needle)) {
        return rows;
      }
    }
    return [];
  });
}

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
  // The optional one is gone too, so nothing downstream can quietly run on a
  // default api-version and call that "configured".
  expect(process.env.AZURE_AI_API_VERSION).toBeUndefined();
});

test('PLATFORM: the platform owner still reads their roster of gyms', async () => {
  mockRequirePrincipal.mockResolvedValue(principal('platform_owner', { organizationId: 'platform' }));
  databaseAnswers([
    ['pilot.organizations', [
      { organization_id: 'gym-1', organization_name: 'Gym One', status: 'active', created_at: 'x', updated_at: 'x' },
    ]],
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
  databaseAnswers([
    ['pilot.athlete_floor_plans', [{ athlete_id: 'ath-1', payload: { athleteName: 'Rosa', tasks: [] } }]],
  ]);

  const response = await floorPlansGET(new NextRequest('http://localhost/api/pilot/floor-plans'));

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({ items: [{ athleteName: 'Rosa', tasks: [] }] });
});

test('COACH: the REAL Morning Read digest assembles, over the REAL access scope', async () => {
  mockRequirePrincipal.mockResolvedValue(principal('coach'));
  // The only row this gym has is one athlete this coach actively covers. It
  // is answered to the coverage union -- the real athleteIdsForCoach -- and
  // every other read the real getCoachIntelligence issues answers empty.
  databaseAnswers([
    ['covering_coach_id', [{ athlete_id: 'ath-1' }]],
  ]);

  const response = await coachIntelligenceGET(
    new NextRequest('http://localhost/api/pilot/coach/intelligence'),
  );

  expect(response.status).toBe(200);
  // The whole digest, assembled by the production function with the AI
  // endpoint gone. Asserting the object rather than a mock call is the
  // point: this is what a coach's morning is built from, and it exists.
  await expect(response.json()).resolves.toEqual({
    open_safety_escalations: [],
    open_compliance_violations: [],
    stalled_gaps: [],
    readiness_concerns: [],
    fading_attendance: [],
    unreviewed_sessions: [],
    expiring_holds: [],
  });
  // ...and it really did fan out to the database rather than short-circuit.
  // getCoachIntelligence returns that same empty digest WITHOUT issuing a
  // single read when the athlete list is empty, so the assertion above would
  // pass on a scope that resolved to nobody while proving nothing ran. The
  // count is the difference between "the digest was built" and "the digest
  // was skipped".
  expect(mockQuery.mock.calls.length).toBeGreaterThan(1);
  // Named rather than merely counted: these are the digest's OWN reads --
  // item 1 (stalled gaps), item 5 (expiring holds) and the delegated
  // escalation ladder. A count alone would still pass if the fan-out came
  // from somewhere else entirely.
  const asked = mockQuery.mock.calls.map(([sql]) => String(sql)).join('\n');
  expect(asked).toContain('pilot.progression_gaps');
  expect(asked).toContain('pilot.training_holds');
  expect(asked).toContain('pilot.safety_escalations');
});

test('ATHLETE: the REAL assignment read still returns the work assigned to them', async () => {
  mockRequirePrincipal.mockResolvedValue(principal('athlete', { athleteId: 'ath-1' }));
  databaseAnswers([
    ['pilot.drill_assignments', [{ assignment_id: 'assignment-1', athlete_id: 'ath-1', drill_name: 'Jump rope' }]],
  ]);

  const response = await progressionAssignmentsGET(
    new NextRequest('http://localhost/api/pilot/progression/assignments?athlete_id=ath-1'),
  );

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    items: [{ assignment_id: 'assignment-1', athlete_id: 'ath-1', drill_name: 'Jump rope' }],
  });
  // The real getAthleteAssignments ran: it asked the assignments table, and
  // it asked inside this athlete's own organization.
  const [sql, params] = mockQuery.mock.calls[0];
  expect(sql).toContain('pilot.drill_assignments');
  expect(params).toEqual(expect.arrayContaining(['org-1', 'ath-1']));
  expect(mockQueryOne).not.toHaveBeenCalled();
});
