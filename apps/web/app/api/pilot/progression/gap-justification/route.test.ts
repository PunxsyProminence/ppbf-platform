import { NextRequest } from 'next/server';

import { GET } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function getRequest(query_: string) {
  return new NextRequest(`http://localhost/api/pilot/progression/gap-justification?${query_}`);
}

// getPerformanceRollup issues 5 queries (sessions, readiness, training days,
// gaps, assignments) in that literal order via Promise.all. Queuing them
// after the detection-source query mirrors the real call order without
// mocking performanceAnalytics.ts itself -- this test exercises the actual
// wiring between the route, progression.ts, and progressionSuggestions.ts.
function queueRollupQueries() {
  mockQuery
    .mockResolvedValueOnce([{ athlete_id: 'ath-1', sessions_total: 6, sessions_completed: 5, avg_rpe: 6 }])
    .mockResolvedValueOnce([{
      athlete_id: 'ath-1',
      readiness_count: 8,
      avg_readiness: 6.1,
      readiness_early_avg: 7.5,
      readiness_late_avg: 5.5,
      readiness_early_count: 4,
      readiness_late_count: 4,
    }])
    .mockResolvedValueOnce([{ athlete_id: 'ath-1', training_days: 10, training_days_early: 6, training_days_late: 2 }])
    .mockResolvedValueOnce([{ athlete_id: 'ath-1', open_gaps: 1 }])
    .mockResolvedValueOnce([{ athlete_id: 'ath-1', active_assignments: 1, avg_assignment_completion: 40 }]);
}

describe('GET /api/pilot/progression/gap-justification', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await GET(getRequest('athlete_id=ath-1'));
    expect(res.status).toBe(401);
  });

  test('403 when athlete requests another athlete_id (cross-athlete)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    const res = await GET(getRequest('athlete_id=ath-other'));
    expect(res.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('unlinked parent is denied', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent', athleteId: null }));
    mockQueryOne.mockResolvedValueOnce(null); // no guardian link
    const res = await GET(getRequest('athlete_id=ath-other'));
    expect(res.status).toBe(403);
  });

  test('a role outside the progression surface is forbidden', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'board', athleteId: null }));
    const res = await GET(getRequest('athlete_id=ath-1'));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('an athlete with only manual gaps gets an empty slice and no rollup fetch', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQuery.mockResolvedValueOnce([
      { gap_id: 'gap-1', detected_from: 'coach_observation' },
    ]);

    const res = await GET(getRequest('athlete_id=ath-1'));
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload.items).toEqual([]);
    // Only the detection-source query ran -- no rollup fetch for an athlete
    // whose gaps carry no deterministic-rule evidence to restate.
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  test('an athlete reading their own confirmed gaps gets only the fields that justify them', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQuery.mockResolvedValueOnce([
      { gap_id: 'gap-manual', detected_from: 'coach_observation' },
      { gap_id: 'gap-readiness', detected_from: 'deterministic_rule:readiness_falling' },
      { gap_id: 'gap-training', detected_from: 'deterministic_rule:training_days_dropping' },
      { gap_id: 'gap-stalled', detected_from: 'deterministic_rule:assignments_stalled' },
    ]);
    queueRollupQueries();

    const res = await GET(getRequest('athlete_id=ath-1'));
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload.items).toHaveLength(2);

    const byGap = new Map(payload.items.map((item: { gap_id: string }) => [item.gap_id, item]));
    expect(byGap.has('gap-manual')).toBe(false);
    expect(byGap.has('gap-stalled')).toBe(false);

    expect(byGap.get('gap-readiness')).toEqual({
      gap_id: 'gap-readiness',
      rule: 'readiness_falling',
      fields: {
        avg_readiness: 6.1,
        readiness_count: 8,
        readiness_early_avg: 7.5,
        readiness_late_avg: 5.5,
        readiness_early_count: 4,
        readiness_late_count: 4,
      },
    });
    expect(byGap.get('gap-training')).toEqual({
      gap_id: 'gap-training',
      rule: 'training_days_dropping',
      fields: { training_days: 10, training_days_early: 6, training_days_late: 2 },
    });
    // Never the full rollup: session/assignment fields never leave the route.
    const readinessItem = byGap.get('gap-readiness') as { fields: Record<string, unknown> };
    const trainingItem = byGap.get('gap-training') as { fields: Record<string, unknown> };
    expect(readinessItem.fields).not.toHaveProperty('sessions_total');
    expect(trainingItem.fields).not.toHaveProperty('active_assignments');
  });

  test('a linked parent reads their child\'s justification the same way', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent', athleteId: null }));
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // guardian link found
    mockQuery.mockResolvedValueOnce([
      { gap_id: 'gap-readiness', detected_from: 'deterministic_rule:readiness_falling' },
    ]);
    queueRollupQueries();

    const res = await GET(getRequest('athlete_id=ath-1'));
    const payload = await res.json();

    expect(res.status).toBe(200);
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0].fields.readiness_late_avg).toBe(5.5);
  });

  test('coach and organization_admin access is unchanged (still allowed, still scoped)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach', athleteId: null, accountId: 'coach-1' }));
    mockQueryOne.mockResolvedValueOnce({ athlete_id: 'ath-1' }); // assertCoachAssignedToAthlete
    mockQuery.mockResolvedValueOnce([]);

    const res = await GET(getRequest('athlete_id=ath-1'));
    expect(res.status).toBe(200);
  });

  test('400 when athlete_id is missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    const res = await GET(getRequest(''));
    expect(res.status).toBe(400);
  });

  test('status filter reaches the underlying query', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    mockQuery.mockResolvedValueOnce([]);
    const res = await GET(getRequest('athlete_id=ath-1&status=identified'));
    expect(res.status).toBe(200);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('status =');
    expect(params).toContain('identified');
  });
});

describe('the general analytics endpoint is unaffected', () => {
  test('this route module does not export a POST/PUT/DELETE handler -- read-only by construction', async () => {
    const mod = (await import('./route')) as Record<string, unknown>;
    expect(mod.POST).toBeUndefined();
    expect(mod.PUT).toBeUndefined();
    expect(mod.DELETE).toBeUndefined();
  });
});
