import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { listAthleteCoachMessages } from '@/src/server/pilot/athleteCoachMessages';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// The athlete gate is faked at its contract; the read itself (own messages
// only, staff-written, no other gym) is proved on Postgres in
// athleteCoachMessages.pg.test.ts. (#1542, FC-06)
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/athleteCoachMessages', () => ({
  listAthleteCoachMessages: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockAccess = jest.mocked(assertActorCanAccessAthlete);
const mockList = jest.mocked(listAthleteCoachMessages);

function principal(role: string, athleteId: string | null = 'ath-1') {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-1',
    athleteId,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as never;
}

const MESSAGE = { note_id: 'n1', note_text: 'Great work on the jab.', created_at: '2026-10-13T22:00:00.000Z', from_name: 'Coach Pat' };

beforeEach(() => {
  jest.clearAllMocks();
  mockAccess.mockResolvedValue(undefined);
});

describe('GET /api/pilot/athlete/coach-messages (#1542, FC-06)', () => {
  test("the athlete reads their own messages: the athlete comes from the session, never the request", async () => {
    mockRequirePrincipal.mockResolvedValue(principal('athlete', 'ath-1'));
    mockList.mockResolvedValue([MESSAGE]);

    const response = await GET(new NextRequest('http://localhost/api/pilot/athlete/coach-messages?athlete_id=ath-other'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, items: [MESSAGE] });
    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), 'ath-1');
    expect(mockList).toHaveBeenCalledWith('org-1', 'ath-1');
  });

  test.each(['parent', 'coach', 'organization_admin', 'admin', 'board', 'platform_owner'])('%s is refused and nothing is read', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    const response = await GET(new NextRequest('http://localhost/api/pilot/athlete/coach-messages'));

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('an athlete account linked to no athlete reads nothing', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('athlete', null));

    const response = await GET(new NextRequest('http://localhost/api/pilot/athlete/coach-messages'));

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('when the athlete gate refuses (a deleted record), nothing is read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('athlete'));
    mockAccess.mockRejectedValue(new Error('Forbidden: athlete does not belong to organization'));

    const response = await GET(new NextRequest('http://localhost/api/pilot/athlete/coach-messages'));

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });
});
