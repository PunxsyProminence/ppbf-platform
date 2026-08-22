import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { getAthletePassbook } from '@/src/server/pilot/passbook';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/passbook', () => ({
  getAthletePassbook: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAssertAccess = assertActorCanAccessAthlete as jest.Mock;
const mockGetPassbook = getAthletePassbook as jest.Mock;

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'athlete-account-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function request(query = 'athlete_id=ath-1'): NextRequest {
  return new NextRequest(`http://localhost/api/pilot/passbook?${query}`);
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/passbook', () => {
  test('requires authentication', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(mockGetPassbook).not.toHaveBeenCalled();
  });

  test('rejects board access to an individual athlete passbook', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'board', athleteId: null }));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mockAssertAccess).not.toHaveBeenCalled();
    expect(mockGetPassbook).not.toHaveBeenCalled();
  });

  test('requires an athlete id', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const response = await GET(request(''));

    expect(response.status).toBe(400);
    expect(mockAssertAccess).not.toHaveBeenCalled();
  });

  test('checks per-athlete access before assembling the organization-scoped passbook', async () => {
    const actor = principal({ accountId: 'coach-1', role: 'coach', athleteId: null });
    mockRequirePrincipal.mockResolvedValueOnce(actor);
    mockAssertAccess.mockResolvedValueOnce(undefined);
    mockGetPassbook.mockResolvedValueOnce({ athlete: { athlete_id: 'ath-1' }, pages: {} });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mockAssertAccess).toHaveBeenCalledWith(actor, 'ath-1');
    expect(mockGetPassbook).toHaveBeenCalledWith('org-1', 'ath-1', 'coach');
  });

  // pilot.coach_observations is shared with guardian-authored barrier reports
  // and staff conduct notes, and this route's gate admits the athlete
  // themselves plus every linked guardian. The reader's role therefore has to
  // reach getAthletePassbook, which owns the per-audience note_type
  // allow-list; a route that dropped it would hand every reader the widest
  // book the module can build.
  test.each([
    ['athlete', { accountId: 'athlete-account-1', athleteId: 'ath-1' }],
    ['parent', { accountId: 'parent-account-1', athleteId: null }],
    ['coach', { accountId: 'coach-1', athleteId: null }],
    ['organization_admin', { accountId: 'admin-1', athleteId: null }],
    ['admin', { accountId: 'admin-legacy-1', athleteId: null }],
  ] as const)('passes the %s reader role down so the observation scope can be decided', async (role, identity) => {
    const actor = principal({ role, ...identity });
    mockRequirePrincipal.mockResolvedValueOnce(actor);
    mockAssertAccess.mockResolvedValueOnce(undefined);
    mockGetPassbook.mockResolvedValueOnce({ athlete: { athlete_id: 'ath-1' }, pages: {} });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mockGetPassbook).toHaveBeenCalledWith('org-1', 'ath-1', role);
  });

  test.each([
    ['athlete', { accountId: 'athlete-account-1', athleteId: 'ath-1' }],
    ['parent', { accountId: 'parent-account-1', athleteId: null }],
  // getAthletePassbook is mocked here, so this pins the route's pass-through:
  // an authorized athlete/guardian still receives the corner and the gaps.
  // WHICH coach_observations rows the corner may carry is decided one layer
  // down and is pinned in src/server/pilot/passbook.test.ts.
  ] as const)('allows an authorized %s to receive the scoped coach observations and progression gaps in the book', async (role, identity) => {
    const actor = principal({ role, ...identity });
    mockRequirePrincipal.mockResolvedValueOnce(actor);
    mockAssertAccess.mockResolvedValueOnce(undefined);
    mockGetPassbook.mockResolvedValueOnce({
      athlete: { athlete_id: 'ath-1' },
      pages: {
        corner: { observations: [{ note_id: 'note-1' }] },
        progression_gaps: [{ gap_id: 'gap-1' }],
      },
    });

    const response = await GET(request());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockAssertAccess).toHaveBeenCalledWith(actor, 'ath-1');
    expect(body.passbook.pages.corner.observations).toEqual([{ note_id: 'note-1' }]);
    expect(body.passbook.pages.progression_gaps).toEqual([{ gap_id: 'gap-1' }]);
  });

  test('does not disclose whether an authorized-scope lookup is missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockAssertAccess.mockResolvedValueOnce(undefined);
    mockGetPassbook.mockResolvedValueOnce(null);

    const response = await GET(request());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Not found' });
  });

  test('stops before reading when the shared athlete-access guard refuses', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent', athleteId: null }));
    mockAssertAccess.mockRejectedValueOnce(new Error('Forbidden: parent not linked to athlete'));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mockGetPassbook).not.toHaveBeenCalled();
  });
});
