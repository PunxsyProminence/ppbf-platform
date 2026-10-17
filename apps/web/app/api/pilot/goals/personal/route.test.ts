import { NextRequest } from 'next/server';

import { PATCH } from './route';
import { markPersonalGoalReached, undoPersonalGoalReached } from '@/src/server/pilot/achievements';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';

jest.mock('@/src/server/pilot/achievements', () => ({
  ...jest.requireActual('@/src/server/pilot/achievements'),
  markPersonalGoalReached: jest.fn(),
  undoPersonalGoalReached: jest.fn(),
}));

jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertActorCanAccessAthlete: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));

// The undo runs its reversal and audit write on one transaction; here the
// transaction is a pass-through so the calls inside it are observable.
jest.mock('@/src/server/pilot/db', () => ({
  ...jest.requireActual('@/src/server/pilot/db'),
  withTransaction: jest.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({ tx: true })),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAssertAccess = assertActorCanAccessAthlete as jest.Mock;
const mockMarkReached = markPersonalGoalReached as jest.Mock;
const mockUndo = undoPersonalGoalReached as jest.Mock;

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

describe('PATCH /api/pilot/goals/personal with undo (UXB Q1 B, lane U3 L5b)', () => {
  test('the athlete takes back their own mark: a reversal with its own audit event carrying the mark it reversed', async () => {
    mockUndo.mockResolvedValue({
      goal_id: 'goal_mine_1',
      athlete_id: 'ath-attacker',
      reached_at: null,
      undone_reached_at: '2026-10-17T20:00:00.000Z',
    });

    const response = await PATCH(request({ athlete_id: 'ath-attacker', goal_id: 'goal_mine_1', undo: true }));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ ok: true, goal: { goal_id: 'goal_mine_1', reached_at: null } });
    expect(body.goal.undone_reached_at).toBeUndefined();
    // The owner the route cleared is what the statement is keyed on, on the transaction.
    expect(mockUndo).toHaveBeenCalledWith('org-a', 'goal_mine_1', 'ath-attacker', expect.any(Date), { tx: true });
    expect(mockMarkReached).not.toHaveBeenCalled();
    expect(writePilotAuditEvent).toHaveBeenCalledTimes(1);
    // Written on the same transaction as the reversal.
    expect(writePilotAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      entity_type: 'goal',
      entity_id: 'goal_mine_1',
      details: { athlete_id: 'ath-attacker', reached: false, undone_reached_at: '2026-10-17T20:00:00.000Z' },
    }), { tx: true });
  });

  test('a failed audit write fails the undo, so the transaction rolls the reversal back', async () => {
    mockUndo.mockResolvedValue({ goal_id: 'goal_mine_1', athlete_id: 'ath-attacker', reached_at: null, undone_reached_at: '2026-10-17T20:00:00.000Z' });
    (writePilotAuditEvent as jest.Mock).mockRejectedValueOnce(new Error('audit insert failed'));

    const response = await PATCH(request({ athlete_id: 'ath-attacker', goal_id: 'goal_mine_1', undo: true }));

    expect(response.status).toBeGreaterThanOrEqual(500);
  });

  /* Condition 1 (Overwatch): undo never touches a mark a coach or admin made.
     The statement cannot see who marked a goal, so this holds only while an
     athlete is the only role that can mark one and markPersonalGoalReached is
     the only writer of reached_at. Pinned here, so adding a coach to the writer
     roles, or a second reached_at writer, fails this rather than quietly
     letting an athlete undo a coach's mark. */
  test('only athletes can mark an own-words goal, and only markPersonalGoalReached sets reached_at', () => {
    const fs = jest.requireActual('node:fs') as typeof import('node:fs');
    const path = jest.requireActual('node:path') as typeof import('node:path');
    const routeSource = fs.readFileSync(path.join(__dirname, 'route.ts'), 'utf8');
    expect(routeSource).toMatch(/const GOAL_WRITER_ROLES = \['athlete'\] as const;/);

    const serverSource = fs.readFileSync(path.resolve(__dirname, '../../../../../src/server/pilot/achievements.ts'), 'utf8');
    const writes = serverSource.match(/set reached_at = \$\d/g) ?? [];
    expect(writes).toHaveLength(1);
    expect(serverSource).toMatch(/export async function markPersonalGoalReached[\s\S]*?set reached_at = \$3/);
  });

  test('a mark past the window (or not theirs) is refused in words, and nothing is audited', async () => {
    mockUndo.mockResolvedValue(null);

    const response = await PATCH(request({ athlete_id: 'ath-attacker', goal_id: 'goal_mine_1', undo: true }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'That can no longer be undone.' });
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test('an undo naming another athlete is refused before any write', async () => {
    const response = await PATCH(request({ athlete_id: 'ath-victim', goal_id: 'goal_theirs_1', undo: true }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockUndo).not.toHaveBeenCalled();
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test('a coach cannot undo an athlete\'s mark', async () => {
    mockRequirePrincipal.mockResolvedValue({
      accountId: 'acct-coach', role: 'coach', organizationId: 'org-a', athleteId: null, sessionToken: 'token', authProvider: 'microsoft',
    });
    mockAssertAccess.mockResolvedValue(undefined);

    const response = await PATCH(request({ athlete_id: 'ath-mine', goal_id: 'goal_1', undo: true }));

    expect(response.status).toBe(403);
    expect(mockUndo).not.toHaveBeenCalled();
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

  test('a coach cannot mark an athlete\'s goal reached, even one they can reach (lane N8-05)', async () => {
    // Owner ruling 2026-10-12: coaches read an athlete's goals; only the
    // athlete marks one reached. Until N8-05 a coach could, with no screen.
    mockRequirePrincipal.mockResolvedValue({
      accountId: 'acct-coach',
      role: 'coach',
      organizationId: 'org-a',
      athleteId: null,
      sessionToken: 'token',
      authProvider: 'microsoft',
    });
    mockAssertAccess.mockResolvedValue(undefined);

    const response = await PATCH(request({ athlete_id: 'ath-mine', goal_id: 'goal_theirs_1' }));

    expect(response.status).toBe(403);
    expect(mockMarkReached).not.toHaveBeenCalled();
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });
});
