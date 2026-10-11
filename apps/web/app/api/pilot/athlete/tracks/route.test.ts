import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { requirePrincipal } from '@/src/server/pilot/http';
import { readAthleteTracks } from '@/src/server/pilot/trackAssignments';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/*
  Own record only, read-only (OD-2026-10-07-010 ruling 3). The assertions are
  about the ways that can go wrong: a role other than the athlete served,
  another athlete reached through a query parameter, the live-row gate
  skipped, and the read made in a gym other than the session's.
*/

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

jest.mock('@/src/server/pilot/trackAssignments', () => ({ readAthleteTracks: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAssertAccess = assertActorCanAccessAthlete as jest.Mock;
const mockReadTracks = readAthleteTracks as jest.Mock;

afterEach(() => {
  jest.resetAllMocks();
});

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-athlete-a',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = (query = '') => new NextRequest(`http://localhost/api/pilot/athlete/tracks${query}`);

describe('who may reach this route', () => {
  test.each(['parent', 'coach', 'organization_admin', 'admin', 'platform_owner', 'board'])(
    'the %s role is refused, and nothing is read',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

      const response = await GET(getRequest('?athlete_id=ath-1'));

      expect(response.status).toBe(403);
      expect(mockAssertAccess).not.toHaveBeenCalled();
      expect(mockReadTracks).not.toHaveBeenCalled();
    },
  );

  test('an athlete account with no athlete record is refused, and nothing is read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ athleteId: null }));

    const response = await GET(getRequest());

    expect(response.status).toBe(400);
    expect(mockReadTracks).not.toHaveBeenCalled();
  });

  test('an athlete whose record is no longer live is refused, and nothing is read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockAssertAccess.mockRejectedValue(new Error('Forbidden: athlete not found in organization'));

    const response = await GET(getRequest());

    expect(response.status).toBe(403);
    expect(mockReadTracks).not.toHaveBeenCalled();
  });
});

describe('what an athlete reads', () => {
  test('their own tracks, from their own gym, as the helper returns them', async () => {
    const actor = principal({ organizationId: 'org-7', athleteId: 'ath-9' });
    mockRequirePrincipal.mockResolvedValue(actor);
    mockReadTracks.mockResolvedValue(['usa_boxing', 'collegiate']);

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tracks: ['usa_boxing', 'collegiate'] });
    expect(mockAssertAccess).toHaveBeenCalledWith(actor, 'ath-9');
    expect(mockReadTracks).toHaveBeenCalledTimes(1);
    expect(mockReadTracks).toHaveBeenCalledWith('org-7', 'ath-9');
  });

  test('an athlete_id or organization_id in the query string is never read', async () => {
    const actor = principal();
    mockRequirePrincipal.mockResolvedValue(actor);
    mockReadTracks.mockResolvedValue([]);

    const response = await GET(getRequest('?athlete_id=ath-other&organization_id=org-other'));

    expect(response.status).toBe(200);
    expect(mockAssertAccess).toHaveBeenCalledWith(actor, 'ath-1');
    expect(mockReadTracks).toHaveBeenCalledWith('org-1', 'ath-1');
  });

  test('none assigned is an empty list', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockReadTracks.mockResolvedValue([]);

    const response = await GET(getRequest());

    expect(await response.json()).toEqual({ tracks: [] });
  });
});
