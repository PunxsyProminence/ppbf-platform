import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { decideOnRecommendation, getRecommendationAthleteId } from '@/src/server/pilot/shadowRecommendations';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  assertActorCanAccessAthlete: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowReadiness', () => ({
  assertShadowRuntimeReadiness: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowRecommendations', () => ({
  getRecommendationAthleteId: jest.fn(),
  decideOnRecommendation: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockReadiness = assertShadowRuntimeReadiness as jest.Mock;
const mockOwner = getRecommendationAthleteId as jest.Mock;
const mockDecide = decideOnRecommendation as jest.Mock;

// The coach signed in. They are the coach of record for ath-mine and have no
// relationship at all to ath-victim -- no assignment, no coach_coverage grant.
const MINE = 'ath-mine';
const VICTIM = 'ath-victim';

function principal() {
  return {
    accountId: 'acct-coach',
    role: 'coach',
    organizationId: 'org-a',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function request(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/shadow/recommendations/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function decidedRow(athleteId: string) {
  return {
    recommendation_id: 'rec-1',
    organization_id: 'org-a',
    athlete_id: athleteId,
    source_formula_result_id: null,
    recommendation_text: 'Cleared to return to full-contact sparring.',
    expected_outcome: 'No symptom recurrence over two sessions.',
    status: 'accepted',
    created_by_account_id: 'acct-other-coach',
    created_at: '2026-08-25T00:00:00Z',
    expires_at: '2026-08-28T00:00:00Z',
    decided_by_account_id: 'acct-coach',
    decided_at: '2026-08-25T01:00:00Z',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockReadiness.mockResolvedValue(undefined);
  // The real gate: this coach reaches ath-mine and nothing else.
  mockAccess.mockImplementation(async (_actor: unknown, athleteId: string) => {
    if (athleteId !== MINE) {
      throw new Error('Forbidden: coach not assigned to athlete');
    }
  });
  mockDecide.mockResolvedValue(decidedRow(MINE));
});

describe('shadow recommendation decide authorizes the STORED athlete, not the payload one', () => {
  // THE BUG. The route authorized `body.athleteId` -- an athlete id the caller
  // picks -- and then called an UPDATE keyed on (organization_id,
  // recommendation_id) alone. Nothing tied the athlete that was checked to the
  // row that was written, so a coach sent one of their OWN athletes to satisfy
  // the gate plus another child's recommendationId to aim the write, and the
  // status/decided_by/decided_at of that child's row committed. The response
  // then handed back the whole row, disclosing the recommendation text about a
  // child the caller has no relationship with.
  //
  // pilot.shadow_recommendations rows only exist for an athlete holding a
  // current 'cleared' medical administrative status (see
  // createProvisionalRecommendation), so what is being accepted or rejected
  // here is a participation/return-to-play judgement about a minor.

  test('REFUSES a payload that pairs a reachable athlete with another child\'s recommendation, and writes nothing', async () => {
    mockOwner.mockResolvedValue(VICTIM);

    const response = await POST(request({
      athleteId: MINE,          // the gate the attacker can satisfy
      recommendationId: 'rec-victim', // the row they actually want to move
      decision: 'accepted',
    }));

    expect(response.status).toBe(404);
    // The write must not have happened at all -- a 404 returned after the
    // UPDATE committed is the failure mode this whole vein is about.
    expect(mockDecide).not.toHaveBeenCalled();
    // And the authorization decision must have been taken against the STORED
    // owner. If this route ever goes back to checking body.athleteId, the
    // access gate is asked about ath-mine, it says yes, and the write lands.
    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-coach' }), VICTIM);
    expect(mockAccess).not.toHaveBeenCalledWith(expect.anything(), MINE);
  });

  test('REFUSES with the same hidden not-found when the recommendation does not exist', async () => {
    mockOwner.mockResolvedValue(null);

    const response = await POST(request({
      athleteId: MINE,
      recommendationId: 'rec-does-not-exist',
      decision: 'rejected',
    }));

    // Byte-identical to the refusal above: a caller must not be able to tell
    // "this id belongs to a child you cannot reach" from "this id is not real".
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not found' });
    expect(mockDecide).not.toHaveBeenCalled();
  });

  test('REFUSES a mismatched pair even when the actor may reach BOTH athletes', async () => {
    // A coach covering two athletes passes athlete A with athlete B's
    // recommendation. Authorization alone cannot catch this, which is why the
    // stated athlete has to match the stored one as a second layer.
    const OTHER_MINE = 'ath-mine-2';
    mockAccess.mockResolvedValue(undefined);
    mockOwner.mockResolvedValue(OTHER_MINE);

    const response = await POST(request({
      athleteId: MINE,
      recommendationId: 'rec-other',
      decision: 'accepted',
    }));

    expect(response.status).toBe(404);
    expect(mockDecide).not.toHaveBeenCalled();
  });

  test('the legitimate decision still WORKS, and carries the authorized owner into the write', async () => {
    mockOwner.mockResolvedValue(MINE);

    const response = await POST(request({
      athleteId: MINE,
      recommendationId: 'rec-1',
      decision: 'accepted',
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, recommendation: decidedRow(MINE) });
    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acct-coach' }), MINE);
    // The authorized athlete travels into the write, so the UPDATE's own
    // predicate is bound to the row whose owner was just checked.
    expect(mockDecide).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-a',
      athleteId: MINE,
      recommendationId: 'rec-1',
      decision: 'accepted',
      decidedByAccountId: 'acct-coach',
    }));
  });

  test('an already-decided recommendation still reports not-found rather than a fresh decision', async () => {
    mockOwner.mockResolvedValue(MINE);
    mockDecide.mockResolvedValue(null);

    const response = await POST(request({
      athleteId: MINE,
      recommendationId: 'rec-1',
      decision: 'rejected',
    }));

    expect(response.status).toBe(404);
  });

  test('an invalid payload is still refused before any lookup', async () => {
    const response = await POST(request({ athleteId: MINE, recommendationId: 'rec-1', decision: 'maybe' }));

    expect(response.status).toBe(400);
    expect(mockOwner).not.toHaveBeenCalled();
    expect(mockDecide).not.toHaveBeenCalled();
  });
});
