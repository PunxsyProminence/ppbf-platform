import { NextRequest } from 'next/server';

import { POST } from './route';
import { awardMilestone, undoSelfMilestone } from '@/src/server/pilot/achievements';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';

/**
 * POST with `undo: true` (OD-2026-10-17-003, lane L43): an athlete takes back
 * their own milestone "I did it" within ten minutes. The statement
 * (undoSelfMilestone) decides owner, account, self-only and window; this pins
 * what the route adds around it: only an athlete, only after the athlete is
 * cleared, the actor's own account handed in, the reversal and its audit event
 * on one transaction, and one 409 answer for everything the statement refuses.
 */

jest.mock('@/src/server/pilot/achievements', () => ({
  ...jest.requireActual('@/src/server/pilot/achievements'),
  awardMilestone: jest.fn(),
  undoSelfMilestone: jest.fn(),
}));

jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertActorCanAccessAthlete: jest.fn(),
}));

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));

// The reversal and its audit write run on one transaction; here the
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
const mockAward = awardMilestone as jest.Mock;
const mockUndo = undoSelfMilestone as jest.Mock;

function athletePrincipal() {
  return {
    accountId: 'acct-athlete',
    role: 'athlete',
    organizationId: 'org-a',
    athleteId: 'ath-mine',
    sessionToken: 'token',
    authProvider: 'pin',
  };
}

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/achievements/milestones', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const REVERSED = {
  athlete_id: 'ath-mine',
  milestone_key: 'cond_mile',
  undone_awarded_at: '2026-10-17T20:00:00.000Z',
  undone_at: '2026-10-17T20:04:00.000Z',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(athletePrincipal());
  // An athlete is only ever cleared for their OWN record, as
  // assertActorCanAccessAthlete's athlete branch does.
  mockAssertAccess.mockImplementation(async (_p: unknown, athleteId: string) => {
    if (athleteId !== 'ath-mine') throw new Error('Forbidden: not your athlete');
  });
});

describe('POST /api/pilot/achievements/milestones with undo (OD-2026-10-17-003)', () => {
  test('the athlete takes back their own mark: a reversal, with its audit event on the same transaction', async () => {
    mockUndo.mockResolvedValue(REVERSED);

    const response = await POST(request({ athlete_id: 'ath-mine', milestone_key: 'cond_mile', undo: true }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, undone: { milestone_key: 'cond_mile' } });
    // Keyed on the athlete the route cleared and on the signed-in account, on the transaction.
    expect(mockUndo).toHaveBeenCalledWith({
      organizationId: 'org-a',
      athleteId: 'ath-mine',
      milestoneKey: 'cond_mile',
      actorAccountId: 'acct-athlete',
      client: { tx: true },
    });
    expect(mockAward).not.toHaveBeenCalled();
    expect(writePilotAuditEvent).toHaveBeenCalledTimes(1);
    expect(writePilotAuditEvent).toHaveBeenCalledWith({
      event_type: 'update',
      actor_account_id: 'acct-athlete',
      actor_role: 'athlete',
      organization_id: 'org-a',
      entity_type: 'athlete_milestone',
      entity_id: 'ath-mine:cond_mile',
      details: {
        athlete_id: 'ath-mine',
        milestone_key: 'cond_mile',
        undone: true,
        undone_awarded_at: '2026-10-17T20:00:00.000Z',
      },
    }, { tx: true });
  });

  test('a failed audit write fails the undo, so the transaction rolls the reversal back', async () => {
    mockUndo.mockResolvedValue(REVERSED);
    (writePilotAuditEvent as jest.Mock).mockRejectedValueOnce(new Error('audit insert failed'));

    const response = await POST(request({ athlete_id: 'ath-mine', milestone_key: 'cond_mile', undo: true }));

    expect(response.status).toBeGreaterThanOrEqual(500);
  });

  test('anything the statement refuses (too late, a coach\'s mark, not theirs, already undone) is one 409, unaudited', async () => {
    mockUndo.mockResolvedValue(null);

    const response = await POST(request({ athlete_id: 'ath-mine', milestone_key: 'cond_mile', undo: true }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: 'That can no longer be undone.' });
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
    expect(mockAward).not.toHaveBeenCalled();
  });

  test('an undo naming another athlete is refused before any write', async () => {
    const response = await POST(request({ athlete_id: 'ath-other', milestone_key: 'cond_mile', undo: true }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockUndo).not.toHaveBeenCalled();
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test.each(['coach', 'organization_admin', 'admin'])('a %s cannot undo an athlete\'s mark', async (role) => {
    mockRequirePrincipal.mockResolvedValue({
      accountId: `acct-${role}`, role, organizationId: 'org-a', athleteId: null, sessionToken: 'token', authProvider: 'microsoft',
    });
    mockAssertAccess.mockResolvedValue(undefined);

    const response = await POST(request({ athlete_id: 'ath-mine', milestone_key: 'cond_mile', undo: true }));

    expect(response.status).toBe(403);
    expect(mockUndo).not.toHaveBeenCalled();
    expect(mockAward).not.toHaveBeenCalled();
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test('a mark without undo still marks, and never reaches the undo', async () => {
    mockAward.mockResolvedValue({ athlete_id: 'ath-mine', milestone_key: 'cond_mile', awarded_by_role: 'self', note: '', awarded_at: '2026-10-17T20:00:00.000Z' });

    const response = await POST(request({ athlete_id: 'ath-mine', milestone_key: 'cond_mile' }));

    expect(response.status).toBe(201);
    expect(mockUndo).not.toHaveBeenCalled();
    expect(mockAward).toHaveBeenCalledWith(expect.objectContaining({ awardedByRole: 'self', awardedByAccountId: 'acct-athlete' }));
  });
});
