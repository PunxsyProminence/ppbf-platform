import { NextRequest } from 'next/server';

import { PATCH } from './route';
import { markPersonalGoalReached } from '@/src/server/pilot/achievements';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';

jest.mock('@/src/server/pilot/achievements', () => ({
  ...jest.requireActual('@/src/server/pilot/achievements'),
  markPersonalGoalReached: jest.fn(),
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
const mockAssertAccess = assertActorCanAccessAthlete as jest.Mock;
const mockMarkReached = markPersonalGoalReached as jest.Mock;

function principal() {
  return {
    accountId: 'acct-attacker',
    role: 'athlete',
    organizationId: 'org-a',
    athleteId: 'ath-attacker',
    sessionToken: 'token',
    authProvider: 'pin',
  };
}

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/goals/personal', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  // The caller is only ever authorized for their OWN athlete record. Naming
  // anyone else is refused, exactly as assertActorCanAccessAthlete's athlete
  // branch does ("athlete cannot access another athlete record").
  mockAssertAccess.mockImplementation(async (_p: unknown, athleteId: string) => {
    if (athleteId !== 'ath-attacker') throw new Error('Forbidden: not your athlete');
  });
});

describe('PATCH /api/pilot/goals/personal authorizes the STORED goal owner', () => {
  /*
   * THE BUG.
   *
   * The route authorized the PAYLOAD's athlete_id -- which the caller supplies
   * and which passes trivially when they name themselves -- and then called
   * markPersonalGoalReached(organizationId, goalId), an UPDATE keyed on
   * goal_id ALONE. The stored row's owner was compared to the payload only
   * AFTERWARDS, so the mismatch produced a 404 whose write had already
   * committed: another athlete's own-words goal was permanently stamped
   * reached_at/status='completed' by someone with no relationship to them.
   *
   * There is no route that un-reaches a goal, and markPersonalGoalReached is
   * deliberately idempotent ("a second tap returns the same row with the same
   * date"), so the falsified record is not recoverable through the API. The
   * guardian-facing read (GET, GOAL_ROLES includes 'parent') then shows a
   * linked guardian their child reaching a goal the child never reached.
   *
   * Two concrete callers reach it: an athlete naming their own athlete_id with
   * a peer's goal_id, and a coach naming a current athlete while supplying the
   * goal_id of an athlete whose bounded coverage grant has since expired --
   * the grant lapses for reads and stayed writable here.
   *
   * The sibling create path on the SAME TABLE (POST /api/pilot/goals) was
   * hardened against precisely this shape: it resolves the stored owner and
   * authorizes THAT before writing. The house fix is authorize-and-write as
   * one statement -- UPDATE ... WHERE athlete_id = <authorized owner>
   * RETURNING -- so no row can be reached that the caller was not authorized
   * for, with no window between the check and the write.
   */
  test('a peer’s goal_id is never written, even though the payload names the caller’s own athlete', async () => {
    // The store is asked for a goal that is BOTH this id and this athlete's.
    // The victim's row is not this athlete's, so nothing matches and nothing
    // is written.
    mockMarkReached.mockResolvedValue(null);

    const response = await PATCH(request({ athlete_id: 'ath-attacker', goal_id: 'goal_victim_1' }));

    expect(response.status).toBe(404);
    // The authorized owner travels INTO the write. Without it the statement is
    // keyed on goal_id alone and the victim's row is already stamped by the
    // time any ownership comparison runs.
    expect(mockMarkReached).toHaveBeenCalledWith('org-a', 'goal_victim_1', 'ath-attacker');
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test('a caller cannot reach another athlete’s goal by naming that athlete either', async () => {
    const response = await PATCH(request({ athlete_id: 'ath-victim', goal_id: 'goal_victim_1' }));

    expect(response.status).toBe(403);
    expect(mockMarkReached).not.toHaveBeenCalled();
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test('the legitimate path still works: an athlete marks their own goal reached', async () => {
    mockMarkReached.mockResolvedValue({
      goal_id: 'goal_mine_1',
      athlete_id: 'ath-attacker',
      own_words: 'Show up on the days I do not want to',
      reached_at: '2026-08-25T00:00:00.000Z',
    });

    const response = await PATCH(request({ athlete_id: 'ath-attacker', goal_id: 'goal_mine_1' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      goal: { goal_id: 'goal_mine_1', athlete_id: 'ath-attacker' },
    });
    expect(mockMarkReached).toHaveBeenCalledWith('org-a', 'goal_mine_1', 'ath-attacker');
    expect(writePilotAuditEvent).toHaveBeenCalledTimes(1);
  });

  test('a coach marking a goal for an athlete they can reach still works', async () => {
    mockRequirePrincipal.mockResolvedValue({
      accountId: 'acct-coach',
      role: 'coach',
      organizationId: 'org-a',
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'microsoft',
    });
    mockAssertAccess.mockImplementation(async (_p: unknown, athleteId: string) => {
      if (athleteId !== 'ath-mine') throw new Error('Forbidden: coach not assigned to athlete');
    });
    mockMarkReached.mockResolvedValue({
      goal_id: 'goal_theirs_1',
      athlete_id: 'ath-mine',
      reached_at: '2026-08-25T00:00:00.000Z',
    });

    const response = await PATCH(request({ athlete_id: 'ath-mine', goal_id: 'goal_theirs_1' }));

    expect(response.status).toBe(200);
    expect(mockMarkReached).toHaveBeenCalledWith('org-a', 'goal_theirs_1', 'ath-mine');
  });
});
