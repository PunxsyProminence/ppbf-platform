import { NextRequest } from 'next/server';

import { GET, PUT } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { readRoomNames, setRoomName } from '@/src/server/pilot/roomNames';

/*
 * The room-names route (lane W4-9, RN-1b; OW27-11, OW27-40 A; permission lines
 * approved by Overwatch on #2212: GET any signed-in member, PUT the gym admin
 * only). The database half is roomNames.pg.test.ts; this file pins who may
 * read and who may set, and the body's shape.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/roomNames', () => {
  const actual = jest.requireActual('@/src/server/pilot/roomNames');
  return { ...actual, readRoomNames: jest.fn(), setRoomName: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockRead = readRoomNames as jest.Mock;
const mockSet = setRoomName as jest.Mock;

const URL = 'http://localhost/api/pilot/room-names';
const EVERY_ROLE = ['organization_admin', 'admin', 'platform_owner', 'coach', 'athlete', 'parent', 'board', 'volunteer', 'staff'];
const NOT_THE_GYM_ADMIN = ['platform_owner', 'coach', 'athlete', 'parent', 'board', 'volunteer', 'staff'];
const NAMES = { 'place:front-desk': { name: 'Front Desk', is_default: true } };

function principal(role: string, organizationId = 'org-1') {
  return { accountId: `acct-${role}`, role, organizationId, athleteId: null, sessionToken: 'secret', authProvider: 'microsoft' };
}

function put(body: unknown) {
  return PUT(new NextRequest(URL, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockResolvedValue(NAMES);
  mockSet.mockResolvedValue({ 'place:front-desk': { name: 'Lobby', is_default: false } });
});

describe('GET', () => {
  it.each(EVERY_ROLE)('a signed-in %s reads its own gym\'s names, not cached', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await GET(new NextRequest(URL));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ ok: true, names: NAMES });
    expect(mockRead).toHaveBeenCalledWith('org-1');
  });

  it('reads the organization from the session, and refuses a query that names one', async () => {
    mockPrincipal.mockResolvedValue(principal('coach'));
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
  it.each(['organization_admin', 'admin'])('the gym admin (%s) sets a name for its own gym', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await put({ name_key: 'place:front-desk', display_name: 'Lobby' });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ ok: true, names: { 'place:front-desk': { name: 'Lobby', is_default: false } } });
    expect(mockSet).toHaveBeenCalledWith({
      organizationId: 'org-1', actorAccountId: `acct-${role}`, actorRole: role, nameKey: 'place:front-desk', displayName: 'Lobby',
    });
  });

  it('null passes through to put the default back ("Use the default")', async () => {
    mockPrincipal.mockResolvedValue(principal('organization_admin'));
    const response = await put({ display_name: null, name_key: 'card:my-corner' });
    expect(response.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ nameKey: 'card:my-corner', displayName: null }));
  });

  it.each(NOT_THE_GYM_ADMIN)('a %s cannot change a name', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await put({ name_key: 'place:front-desk', display_name: 'Lobby' });
    expect(response.status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it.each(['coach', 'athlete'])('a %s sending a broken body is refused for its role (403), not for its body', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    for (const body of ['not json', ['Lobby'], { name_key: 'place:front-desk', display_name: 'Lobby', extra: true }]) {
      const response = await put(body);
      expect(response.status).toBe(403);
    }
    expect(mockSet).not.toHaveBeenCalled();
  });

  it.each([
    ['no body', ''],
    ['an array', ['place:front-desk', 'Lobby']],
    ['an empty object', {}],
    ['no display_name', { name_key: 'place:front-desk' }],
    ['no name_key', { display_name: 'Lobby' }],
    ['a third field', { name_key: 'place:front-desk', display_name: 'Lobby', organization_id: 'org-2' }],
    ['different fields', { key: 'place:front-desk', name: 'Lobby' }],
  ])('refuses %s without writing', async (_label, body) => {
    mockPrincipal.mockResolvedValue(principal('organization_admin'));
    const response = await put(body);
    expect(response.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('refuses a query field on the write, so no request can name a gym', async () => {
    mockPrincipal.mockResolvedValue(principal('organization_admin'));
    const response = await PUT(new NextRequest(`${URL}?organization_id=org-2`, {
      method: 'PUT', body: JSON.stringify({ name_key: 'place:front-desk', display_name: 'Lobby' }),
    }));
    expect(response.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('passes the key and name through for the module to refuse', async () => {
    mockPrincipal.mockResolvedValue(principal('organization_admin'));
    mockSet.mockImplementation(jest.requireActual('@/src/server/pilot/roomNames').setRoomName);
    const offList = await put({ name_key: 'place:lobby', display_name: 'Lobby' });
    expect(offList.status).toBe(400);
    expect((await offList.json()).error).toMatch(/not a name the gym can change/);
    const tooLong = await put({ name_key: 'place:front-desk', display_name: 'x'.repeat(41) });
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error).toMatch(/at most 40 characters/);
  });
});
