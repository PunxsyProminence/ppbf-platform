import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listAthleteCoachMessages } from '@/src/server/pilot/athleteCoachMessages';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// requireRole stays real; the athlete gate is faked at its contract. The read
// itself is proved on Postgres in athleteCoachMessages.pg.test.ts. (#1542, FC-06)
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/athleteCoachMessages', () => ({
  listAthleteCoachMessages: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockList = listAthleteCoachMessages as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(role: string): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-1',
    athleteId: role === 'athlete' ? 'ath-1' : null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as PilotPrincipal;
}

function request(query = '?athlete_id=ath-1') {
  return new NextRequest(`http://localhost/api/pilot/coach/athlete-messages${query}`);
}

const NOTE = {
  note_id: 'note-1',
  note_text: 'Great work on the jab.',
  created_at: '2026-10-12T22:40:00.000Z',
  from_name: 'Coach Pat Smith',
};

describe('GET /api/pilot/coach/athlete-messages (#1542, FC-06)', () => {
  test.each(['coach', 'organization_admin', 'admin'])('%s reads what was sent to an athlete of their own gym', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockAccess.mockResolvedValue(undefined);
    mockList.mockResolvedValue([NOTE]);

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [NOTE] });
    expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }), 'ath-1');
    expect(mockList).toHaveBeenCalledWith('org-1', 'ath-1');
  });

  test.each(['athlete', 'parent', 'platform_owner'])('%s is refused and nothing is read', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('when the athlete gate refuses (another gym), nothing is read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockAccess.mockRejectedValue(new Error('Forbidden: athlete does not belong to organization'));

    const response = await GET(request('?athlete_id=ath-elsewhere'));

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('an athlete id is required', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));

    const response = await GET(request(''));

    expect(response.status).toBe(400);
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });
});
