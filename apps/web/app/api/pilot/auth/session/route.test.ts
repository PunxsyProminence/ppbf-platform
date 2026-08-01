import { NextRequest } from 'next/server';

import { POST } from './route';
import { resolvePrincipal } from '@/src/server/pilot/auth';
import { listSeatsForAccount } from '@/src/server/pilot/boardSeats';

jest.mock('@/src/server/pilot/auth', () => ({
  resolvePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/boardSeats', () => ({
  ...jest.requireActual('@/src/server/pilot/boardSeats'),
  listSeatsForAccount: jest.fn(),
}));

const mockResolvePrincipal = jest.mocked(resolvePrincipal);
const mockListSeatsForAccount = jest.mocked(listSeatsForAccount);

function boardPrincipal(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'board-account',
    role: 'board',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'opaque-token',
    authProvider: 'microsoft',
    hasMasterShadowAccess: false,
    ...overrides,
  } as never;
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/pilot/auth/session', () => {
  test('returns a non-cacheable unauthenticated response when the server session is absent or expired', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(null);

    const response = await POST(new NextRequest('https://ppbf.example/api/pilot/auth/session', {
      method: 'POST',
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ authenticated: false });
  });

  test('returns the authoritative role, organization, athlete, and provider from the server principal', async () => {
    mockResolvePrincipal.mockResolvedValueOnce({
      accountId: 'athlete-account',
      role: 'athlete',
      organizationId: 'org-1',
      athleteId: 'athlete-1',
      sessionToken: 'opaque-token',
      authProvider: 'ppbf_local',
      hasMasterShadowAccess: false,
    });

    const response = await POST(new NextRequest('https://ppbf.example/api/pilot/auth/session', {
      method: 'POST',
    }));

    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      account_id: 'athlete-account',
      role: 'athlete',
      organization_id: 'org-1',
      athlete_id: 'athlete-1',
      auth_provider: 'ppbf_local',
    });
  });

  test('keeps server failures non-cacheable', async () => {
    mockResolvePrincipal.mockRejectedValueOnce(new Error('database unavailable'));

    const response = await POST(new NextRequest('https://ppbf.example/api/pilot/auth/session', {
      method: 'POST',
    }));

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('no other role pays for the seat lookup or can present a seat', async () => {
    mockResolvePrincipal.mockResolvedValueOnce({
      accountId: 'coach-account',
      role: 'coach',
      organizationId: 'org-1',
      athleteId: null,
      sessionToken: 'opaque-token',
      authProvider: 'microsoft',
      hasMasterShadowAccess: false,
    });

    const response = await POST(new NextRequest('https://ppbf.example/api/pilot/auth/session', {
      method: 'POST',
    }));
    const payload = await response.json() as Record<string, unknown>;

    expect(mockListSeatsForAccount).not.toHaveBeenCalled();
    expect(Object.keys(payload)).not.toContain('board_seat');
    expect(Object.keys(payload)).not.toContain('board_seats');
  });
});

describe('the board seat reaches the browser', () => {
  test('reports every seat held and the one this session lands on', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(boardPrincipal());
    mockListSeatsForAccount.mockResolvedValueOnce([
      { seat: 'treasurer', is_primary: true },
      { seat: 'at-large', is_primary: false },
    ]);

    const response = await POST(new NextRequest('https://ppbf.example/api/pilot/auth/session', {
      method: 'POST',
    }));

    expect(mockListSeatsForAccount).toHaveBeenCalledWith('org-1', 'board-account');
    await expect(response.json()).resolves.toMatchObject({
      role: 'board',
      board_seat: 'treasurer',
      board_seats: [
        { seat: 'treasurer', is_primary: true },
        { seat: 'at-large', is_primary: false },
      ],
    });
  });

  test('a board member holding no seat reports none and stays on the hub', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(boardPrincipal({ accountId: 'seatless-board' }));
    mockListSeatsForAccount.mockResolvedValueOnce([]);

    const response = await POST(new NextRequest('https://ppbf.example/api/pilot/auth/session', {
      method: 'POST',
    }));

    await expect(response.json()).resolves.toMatchObject({
      role: 'board',
      board_seat: null,
      board_seats: [],
    });
  });

  // The seat decides which page a member lands on; it grants nothing. Losing
  // it must not lock a board member out of the aggregate workspace they are
  // authenticated for.
  test('an unmigrated seat table costs the seat, not the session', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(boardPrincipal());
    mockListSeatsForAccount.mockRejectedValueOnce(
      Object.assign(new Error('relation "pilot.board_seats" does not exist'), { code: '42P01' }),
    );

    const response = await POST(new NextRequest('https://ppbf.example/api/pilot/auth/session', {
      method: 'POST',
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      authenticated: true,
      role: 'board',
      board_seat: null,
    });
  });

  test('any other database failure still surfaces', async () => {
    mockResolvePrincipal.mockResolvedValueOnce(boardPrincipal());
    mockListSeatsForAccount.mockRejectedValueOnce(
      Object.assign(new Error('connection terminated'), { code: '08006' }),
    );

    const response = await POST(new NextRequest('https://ppbf.example/api/pilot/auth/session', {
      method: 'POST',
    }));

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
