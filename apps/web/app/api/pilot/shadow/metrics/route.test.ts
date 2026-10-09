import { NextRequest } from 'next/server';

import { GET } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';

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
jest.mock('@/src/server/pilot/access', () => ({
  requireRole: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowReadiness', () => ({
  assertShadowRuntimeReadiness: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowMetrics', () => ({
  getGrowthMetrics: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowUnlocks', () => ({
  evaluateShadowUnlockState: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);

afterEach(() => {
  jest.clearAllMocks();
});

test('concerned topics exclude pending promote proposals, so praise is never listed as concern', async () => {
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
    positiveOutcomeRate: null,
    filterRate: null,
    avgSatisfaction: null,
    reviewedOutcomes: 0,
    researchRequirementsCreated: 0,
    researchRequirementsClosed: 0,
    newLibraryPatterns: 0,
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
  expect(flagReads[0]).toContain("proposed_action IS DISTINCT FROM 'promote'");
  expect(mockQuery.mock.calls.find(([sql]) => String(sql).includes('shadow_library_review_flags'))?.[1])
    .toEqual(['org-a']);
});
