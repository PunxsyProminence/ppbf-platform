import { NextRequest } from 'next/server';

import { GET, PUT } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { readTabletIdlePolicy, setTabletIdlePolicy } from '@/src/server/pilot/tabletIdlePolicy';

/*
 * The gym tablet idle-time route (lane U1, AS2-a; OW25-53 A). The database half
 * is tabletIdlePolicy.pg.test.ts; this file pins who may read and who may set.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/tabletIdlePolicy', () => {
  const actual = jest.requireActual('@/src/server/pilot/tabletIdlePolicy');
  return { ...actual, readTabletIdlePolicy: jest.fn(), setTabletIdlePolicy: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockRead = readTabletIdlePolicy as jest.Mock;
const mockSet = setTabletIdlePolicy as jest.Mock;

const URL = 'http://localhost/api/pilot/gym-tablet/idle';

function principal(role: string, organizationId = 'org-1') {
  return { accountId: `acct-${role}`, role, organizationId, athleteId: null, sessionToken: 'secret', authProvider: 'microsoft' };
}

function put(body: unknown) {
  return PUT(new NextRequest(URL, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockResolvedValue({ idle_minutes: 60, is_default: true });
  mockSet.mockImplementation(async (input: { idleMinutes: number }) => ({ idle_minutes: input.idleMinutes, is_default: false }));
});

describe('GET', () => {
  it.each(['athlete', 'parent', 'coach', 'organization_admin', 'admin', 'board'])(
    'a signed-in %s reads its own gym\'s number and nothing else',
    async (role) => {
      mockPrincipal.mockResolvedValue(principal(role));
      const response = await GET(new NextRequest(URL));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, idle_minutes: 60, is_default: true, choices: [15, 30, 60, 120, 240] });
      expect(mockRead).toHaveBeenCalledWith('org-1');
    },
  );

  it('reads the organization from the session, and refuses a query that names one', async () => {
    mockPrincipal.mockResolvedValue(principal('athlete'));
    const response = await GET(new NextRequest(`${URL}?organization_id=org-2`));
    expect(response.status).toBe(400);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('a caller with no session is refused before anything is read', async () => {
    mockPrincipal.mockRejectedValue(new Error('Unauthorized'));
    const response = await GET(new NextRequest(URL));
    expect(response.status).toBe(401);
    expect(mockRead).not.toHaveBeenCalled();
  });
});

describe('PUT', () => {
  it.each(['organization_admin', 'admin'])('the gym admin (%s) sets the time for its own gym', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await put({ idle_minutes: 30 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, idle_minutes: 30, is_default: false, choices: [15, 30, 60, 120, 240] });
    expect(mockSet).toHaveBeenCalledWith({ organizationId: 'org-1', actorAccountId: `acct-${role}`, actorRole: role, idleMinutes: 30 });
  });

  it.each(['platform_owner', 'coach', 'athlete', 'parent', 'board'])('a %s cannot change it', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await put({ idle_minutes: 15 });
    expect(response.status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it.each([
    ['no body', ''],
    ['an array', [30]],
    ['a second field', { idle_minutes: 30, organization_id: 'org-2' }],
    ['a different field', { minutes: 30 }],
  ])('refuses %s without writing', async (_label, body) => {
    mockPrincipal.mockResolvedValue(principal('organization_admin'));
    const response = await put(body);
    expect(response.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('passes the value through for the module to refuse a time off the list', async () => {
    mockPrincipal.mockResolvedValue(principal('organization_admin'));
    mockSet.mockImplementation(jest.requireActual('@/src/server/pilot/tabletIdlePolicy').setTabletIdlePolicy);
    const response = await put({ idle_minutes: 1 });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/15, 30, 60, 120, 240/);
  });
});
