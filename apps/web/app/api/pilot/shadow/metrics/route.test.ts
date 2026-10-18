import { NextRequest } from 'next/server';

import { GET } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getGrowthMetrics } from '@/src/server/pilot/shadowMetrics';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { evaluateShadowUnlockState } from '@/src/server/pilot/shadowUnlocks';

/**
 * The "concerned topics" list is read from pilot.shadow_library_review_flags,
 * the table that also holds the 'promote' proposals a human-reviewed thumbs-up
 * queues (shadowLearningLoop.ts queueLibraryEntryChangeForHumanReview). Both
 * sit in review_state 'pending', so without the exclusion pinned here praise
 * is listed as concern (O11 = A, GO-RECS-CONFIRMED 2026-10-08: thumbs-up counts
 * in metrics but makes no flag).
 */

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));
jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowReadiness', () => ({
  assertShadowRuntimeReadiness: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowMetrics', () => ({
  getGrowthMetrics: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowUnlocks', () => ({
  ...jest.requireActual('@/src/server/pilot/shadowUnlocks'),
  evaluateShadowUnlockState: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);
const mockReadiness = jest.mocked(assertShadowRuntimeReadiness);
const mockGrowth = jest.mocked(getGrowthMetrics);
const mockUnlockState = jest.mocked(evaluateShadowUnlockState);

const URL_BASE = 'https://example.test/api/pilot/shadow/metrics';

function as(role: string) {
  mockRequirePrincipal.mockResolvedValue({
    accountId: `acct-${role}`,
    role,
    organizationId: 'org-a',
  } as never);
}

function answerOrgMetrics() {
  mockGrowth.mockResolvedValue({
    period: '30d',
    avgEffectiveness: null,
    totalInteractions: 0,
    reviewedHelpfulRate: null,
    filterRate: null,
    avgSatisfaction: null,
    reviewedOutcomes: 0,
    researchRequirementsCreated: 0,
    researchRequirementsClosed: 0,
    newLibrarySources: 0,
    unavailableReasons: {},
  } as never);
  mockUnlockState.mockResolvedValue({
    features: {
      strong_personalization: { unlocked: true, satisfied: true, measuredPerformance: null },
      // An admin has switched the pipeline on and the counter is met; there is
      // still no fine-tuning code, so it must not read as on.
      fine_tuning_pipeline: { unlocked: true, satisfied: true, measuredPerformance: null },
    },
  } as never);
  mockQueryOne.mockResolvedValue(null);
  mockQuery.mockResolvedValue([] as never);
}

afterEach(() => {
  jest.resetAllMocks();
});

test('concerned topics exclude pending promote and retain proposals, so praise and neutral are never listed as concern', async () => {
  mockRequirePrincipal.mockResolvedValueOnce({
    accountId: 'acct-admin',
    role: 'organization_admin',
    organizationId: 'org-a',
  } as never);
  const { getGrowthMetrics } = jest.requireMock('@/src/server/pilot/shadowMetrics') as {
    getGrowthMetrics: jest.Mock;
  };
  getGrowthMetrics.mockResolvedValueOnce({
    period: '30d',
    avgEffectiveness: null,
    totalInteractions: 0,
    reviewedHelpfulRate: null,
    filterRate: null,
    avgSatisfaction: null,
    reviewedOutcomes: 0,
    researchRequirementsCreated: 0,
    researchRequirementsClosed: 0,
    newLibrarySources: 0,
    unavailableReasons: {},
  });
  const { evaluateShadowUnlockState } = jest.requireMock('@/src/server/pilot/shadowUnlocks') as {
    evaluateShadowUnlockState: jest.Mock;
  };
  evaluateShadowUnlockState.mockResolvedValueOnce(null);
  mockQueryOne.mockResolvedValue(null);
  mockQuery.mockImplementation(async (sql: string) => (
    sql.includes('shadow_library_review_flags')
      ? [{ topic: 'footwork' }] as never
      : [] as never
  ));

  const response = await GET(
    new NextRequest('https://example.test/api/pilot/shadow/metrics'),
  );
  expect(response.status).toBe(200);
  const body = await response.json() as {
    metrics: { effectiveness: { concernedTopics: string[] }; safety: { flaggedTopicsNeedingReview: string[] } };
  };
  expect(body.metrics.effectiveness.concernedTopics).toEqual(['footwork']);
  expect(body.metrics.safety.flaggedTopicsNeedingReview).toEqual(['footwork']);

  const flagReads = mockQuery.mock.calls
    .map(([sql]) => String(sql))
    .filter((sql) => sql.includes('shadow_library_review_flags'));
  expect(flagReads).toHaveLength(1);
  expect(flagReads[0]).toContain("review_state = 'pending'");
  // NULL = a plain negative flag; 'demote' = a negative proposal. 'promote'
  // (praise) and 'retain' (neutral) are proposals, not concern.
  expect(flagReads[0]).toContain("(proposed_action IS NULL OR proposed_action = 'demote')");
  expect(flagReads[0]).not.toContain("DISTINCT FROM 'promote'");
  expect(mockQuery.mock.calls.find(([sql]) => String(sql).includes('shadow_library_review_flags'))?.[1])
    .toEqual(['org-a']);
});

// Everything this route returns is one gym's data (the aggregates,
// viewerUnlocks, the per-member view), so the platform owner is refused on the
// whole of it, before the readiness check and before any read
// (OD-2026-10-10-004 ruling 3).
describe('the platform owner is refused on every shape of the read', () => {
  test.each([
    ['the gym dashboard', URL_BASE],
    ['the gym dashboard over a named period', `${URL_BASE}?days=7`],
    ["one member's view", `${URL_BASE}?userId=acct-member`],
    ['a malformed period', `${URL_BASE}?days=junk`],
  ])('%s: 403, and nothing is read', async (_label, url) => {
    as('platform_owner');
    answerOrgMetrics();

    const response = await GET(new NextRequest(url));

    expect(response.status).toBe(403);
    expect(mockReadiness).not.toHaveBeenCalled();
    expect(mockGrowth).not.toHaveBeenCalled();
    expect(mockUnlockState).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test.each(['organization_admin', 'admin'])("%s still reads its gym's dashboard, viewerUnlocks included", async (role) => {
    as(role);
    answerOrgMetrics();

    const response = await GET(new NextRequest(`${URL_BASE}?days=7`));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ok: boolean;
      metrics: { period: string; viewerUnlocks: Record<string, unknown> };
    };
    expect(body.ok).toBe(true);
    const notEvaluated = {
      dataSufficient: false,
      implemented: true,
      activated: false,
      measuredPerformance: null,
      unavailableReasons: {
        dataSufficient: 'UNLOCK_STATE_UNAVAILABLE',
        activated: 'UNLOCK_STATE_UNAVAILABLE',
        measuredPerformance: 'NOT_MEASURED',
      },
    };
    expect(body.metrics.viewerUnlocks).toEqual({
      strongPersonalization: {
        dataSufficient: true,
        implemented: true,
        activated: true,
        measuredPerformance: null,
        unavailableReasons: { measuredPerformance: 'NOT_MEASURED' },
      },
      autoLibraryUpdates: notEvaluated,
      aggressiveResearchGeneration: notEvaluated,
      // Enough data and switched on, but nothing to switch on: four facts,
      // not one "ready" flag.
      fineTuningPipeline: {
        dataSufficient: true,
        implemented: false,
        activated: false,
        measuredPerformance: null,
        unavailableReasons: { measuredPerformance: 'NOT_MEASURED' },
      },
    });
    expect(body.metrics.viewerUnlocks).not.toHaveProperty('fineTuningPipelineReady');
    expect(mockGrowth).toHaveBeenCalledWith('org-a', 7);
    expect(mockUnlockState).toHaveBeenCalledWith({ organizationId: 'org-a', accountId: `acct-${role}` });
  });

  test('a gym admin still gets "Not found" for a member outside the gym', async () => {
    as('organization_admin');
    answerOrgMetrics();

    const response = await GET(new NextRequest(`${URL_BASE}?userId=acct-elsewhere`));

    expect(response.status).toBe(404);
    expect(mockQueryOne).toHaveBeenCalledTimes(1);
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['acct-elsewhere', 'org-a']);
  });

  test.each(['coach', 'athlete', 'parent', 'board', 'staff', 'volunteer'])('%s is refused, as before', async (role) => {
    as(role);
    answerOrgMetrics();

    expect((await GET(new NextRequest(URL_BASE))).status).toBe(403);
    expect(mockGrowth).not.toHaveBeenCalled();
  });
});
