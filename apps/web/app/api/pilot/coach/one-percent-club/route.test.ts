import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  castVote,
  createNomination,
  getNomination,
  listMembers,
  listNominations,
  listVotes,
  withdrawNomination,
} from '@/src/server/pilot/onePercentClub';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

jest.mock('@/src/server/pilot/onePercentClub', () => {
  const actual = jest.requireActual('@/src/server/pilot/onePercentClub');
  return {
    ...actual,
    listNominations: jest.fn().mockResolvedValue([]),
    listMembers: jest.fn().mockResolvedValue([]),
    getNomination: jest.fn(),
    listVotes: jest.fn().mockResolvedValue([]),
    createNomination: jest.fn(),
    castVote: jest.fn(),
    withdrawNomination: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockListNominations = listNominations as jest.Mock;
const mockListMembers = listMembers as jest.Mock;
const mockGetNomination = getNomination as jest.Mock;
const mockListVotes = listVotes as jest.Mock;
const mockCreate = createNomination as jest.Mock;
const mockVote = castVote as jest.Mock;
const mockWithdraw = withdrawNomination as jest.Mock;

// The athlete gate is permissive by default so each test states its own
// access decision rather than inheriting the previous test's --
// clearAllMocks clears calls, not implementations.
beforeEach(() => {
  mockAccess.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const post = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/coach/one-percent-club', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const get = (query = '') =>
  new NextRequest(`http://localhost/api/pilot/coach/one-percent-club${query}`);

test('parents cannot see or touch the club at all', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent' }));
  expect((await GET(get())).status).toBeGreaterThanOrEqual(400);
  expect((await POST(post({ action: 'nominate', athlete_id: 'a1' }))).status).toBeGreaterThanOrEqual(400);
  expect(mockCreate).not.toHaveBeenCalled();
});

test('coaches, admins, and athletes can all nominate; the source is never taken from the client', async () => {
  mockCreate.mockResolvedValue({ nomination_id: 'nom-1', source: 'coach_nomination' });
  // a1 is this coach's athlete -- the staff gate grants. Its refusal, and the
  // fact that it deliberately does not apply to an athlete nominator, are the
  // next test.
  mockAccess.mockResolvedValue(undefined);

  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  let response = await POST(post({ action: 'nominate', athlete_id: 'a1', source: 'milestone_surfaced' }));
  expect(response.status).toBe(200);
  expect(mockCreate).toHaveBeenLastCalledWith(expect.objectContaining({ nominatorRole: 'coach' }));
  // A client-asserted 'source' in the body is simply not read by the route.
  expect(mockCreate.mock.calls[0][0]).not.toHaveProperty('source');

  mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', athleteId: 'ath-self' }));
  response = await POST(post({ action: 'nominate', athlete_id: 'a1' }));
  expect(response.status).toBe(200);
  expect(mockCreate).toHaveBeenLastCalledWith(expect.objectContaining({
    nominatorRole: 'athlete', nominatorAthleteId: 'ath-self',
  }));
});

test('nominate needs an athlete_id', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  expect((await POST(post({ action: 'nominate' }))).status).toBe(400);
  expect(mockCreate).not.toHaveBeenCalled();
});

test('only coaches and admins vote -- an athlete who can nominate cannot vote', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', athleteId: 'ath-self' }));
  expect((await POST(post({ action: 'vote', nomination_id: 'nom-1', vote: 'yes' }))).status)
    .toBeGreaterThanOrEqual(400);
  expect(mockVote).not.toHaveBeenCalled();

  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  mockVote.mockResolvedValue({
    nomination: { nomination_id: 'nom-1', status: 'open' },
    tally: { eligible_count: 3, yes_count: 1, no_count: 0, majority_reached: false },
  });
  const response = await POST(post({ action: 'vote', nomination_id: 'nom-1', vote: 'yes' }));
  expect(response.status).toBe(200);
  expect(mockVote).toHaveBeenCalledWith(expect.objectContaining({
    nominationId: 'nom-1', voterAccountId: 'acct-1', voterRole: 'coach', vote: 'yes',
  }));
});

test('vote must be yes or no, not any string', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'admin' }));
  expect((await POST(post({ action: 'vote', nomination_id: 'nom-1', vote: 'maybe' }))).status).toBe(400);
  expect(mockVote).not.toHaveBeenCalled();
});

test('only coaches and admins can withdraw -- not the athlete who nominated', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', athleteId: 'ath-self' }));
  expect((await POST(post({ action: 'withdraw', nomination_id: 'nom-1', reason: 'mistake' }))).status)
    .toBeGreaterThanOrEqual(400);
  expect(mockWithdraw).not.toHaveBeenCalled();

  mockRequirePrincipal.mockResolvedValue(principal({ role: 'admin' }));
  mockWithdraw.mockResolvedValue({ nomination_id: 'nom-1', status: 'withdrawn' });
  const response = await POST(post({ action: 'withdraw', nomination_id: 'nom-1', reason: 'filed by mistake' }));
  expect(response.status).toBe(200);
  expect(mockWithdraw).toHaveBeenCalledWith(expect.objectContaining({ nominationId: 'nom-1', reason: 'filed by mistake' }));
});

test('a withdrawal needs a reason', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'admin' }));
  expect((await POST(post({ action: 'withdraw', nomination_id: 'nom-1' }))).status).toBe(400);
  expect(mockWithdraw).not.toHaveBeenCalled();
});

test('reading the roster and an open tally is coach/admin only', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', athleteId: 'ath-self' }));
  expect((await GET(get())).status).toBeGreaterThanOrEqual(400);
  expect(mockListNominations).not.toHaveBeenCalled();

  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  const response = await GET(get());
  expect(response.status).toBe(200);
  expect(mockListNominations).toHaveBeenCalledWith('org-1', true);
  expect(mockListMembers).toHaveBeenCalledWith('org-1');
});

test('one nomination detail includes who voted, when, and the tally -- coach/admin only', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  mockGetNomination.mockResolvedValue({ nomination_id: 'nom-1', status: 'open' });
  mockListVotes.mockResolvedValue([{ voter_display_name: 'Coach A', vote: 'yes', voted_at: '2026-08-16T00:00:00Z' }]);

  const response = await GET(get('?nomination_id=nom-1'));
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload.item.nomination_id).toBe('nom-1');
  expect(payload.votes).toHaveLength(1);
});

test('an unknown action is refused rather than silently ignored', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'admin' }));
  expect((await POST(post({ action: 'crown_them', athlete_id: 'a1' }))).status).toBe(400);
});

test('a staff nominator is gated per athlete; the athlete self/peer path deliberately is not', async () => {
  mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));
  mockCreate.mockResolvedValue({ nomination_id: 'nom-2', source: 'self_peer_nomination' });

  mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach' }));
  expect((await POST(post({ action: 'nominate', athlete_id: 'a-not-mine' }))).status).toBe(403);
  expect(mockCreate).not.toHaveBeenCalled();

  // Path 3 of the owner's design ("an athlete may nominate themselves or a
  // peer") is unchanged: the central gate admits an athlete only for
  // themselves, so applying it here would delete peer nomination rather than
  // secure it. Narrowing that is an owner decision, not a gate fix.
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', athleteId: 'ath-self' }));
  const peer = await POST(post({ action: 'nominate', athlete_id: 'a-teammate' }));
  expect(peer.status).toBe(200);
  expect(mockAccess).toHaveBeenCalledTimes(1);
  expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
    athleteId: 'a-teammate', nominatorRole: 'athlete', nominatorAthleteId: 'ath-self',
  }));
});
