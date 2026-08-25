import { NextRequest } from 'next/server';

import { POST } from './route';
import { getGoalById, upsertGoal } from '@/src/server/pilot/entities';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';

jest.mock('@/src/server/pilot/entities', () => ({
  getGoalById: jest.fn(),
  upsertGoal: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertActorCanAccessAthlete: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetGoalById = getGoalById as jest.Mock;
const mockUpsertGoal = upsertGoal as jest.Mock;
const mockAssertAccess = assertActorCanAccessAthlete as jest.Mock;

function principal() {
  return { accountId: 'acct-attacker', role: 'athlete', organizationId: 'org-a', athleteId: 'ath-attacker' };
}

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/goals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    goal_id: 'goal-1',
    athlete_id: 'ath-attacker',
    title: 'Land the jab',
    target_date: '2026-12-01',
    metric: 'reps',
    status: 'Active',
    category: 'Boxing',
    progress_percent: 0,
    created_at: '2026-08-25T00:00:00Z',
    updated_at: '2026-08-25T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockAssertAccess.mockResolvedValue(undefined);
});

describe('POST /api/pilot/goals', () => {
  // The hijack: reuse a goal_id that belongs to another athlete, naming
  // your OWN athlete_id in the payload. Before the fix the only access check
  // was on payload.athlete_id (which passes), and the UPDATE-first upsert
  // then reassigned the victim's row. The stored-owner check must run and
  // must refuse when the caller cannot access the CURRENT owner.
  test('a reused goal_id owned by another athlete is refused before the write', async () => {
    mockGetGoalById.mockResolvedValueOnce({ goal_id: 'goal-1', athlete_id: 'ath-victim' });
    mockAssertAccess.mockImplementation(async (_p: unknown, athleteId: string) => {
      if (athleteId === 'ath-victim') throw new Error('Forbidden: not your athlete');
    });

    const response = await POST(request(payload()));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockAssertAccess).toHaveBeenCalledWith(expect.anything(), 'ath-victim');
    expect(mockUpsertGoal).not.toHaveBeenCalled();
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test('a genuinely new goal_id has no stored owner and writes normally', async () => {
    mockGetGoalById.mockResolvedValueOnce(null);

    const response = await POST(request(payload()));

    expect(response.status).toBe(200);
    expect(mockUpsertGoal).toHaveBeenCalledTimes(1);
  });

  test('updating your own existing goal still works', async () => {
    mockGetGoalById.mockResolvedValueOnce({ goal_id: 'goal-1', athlete_id: 'ath-attacker' });

    const response = await POST(request(payload()));

    expect(response.status).toBe(200);
    expect(mockUpsertGoal).toHaveBeenCalledTimes(1);
  });
});
