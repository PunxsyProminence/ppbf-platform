import { NextRequest } from 'next/server';

import { GET, PUT } from './route';
import { readGymEmailAlertEvents, setGymEmailAlertEvent } from '@/src/server/pilot/emailAlertGymEvents';
import { requirePrincipal } from '@/src/server/pilot/http';

/*
 * The gym's email alert events route (lane W4-1, EM-5; OW27-10 A, OW27-39 A).
 * The database half is organizationEmailAlertEvents.pg.test.ts; this file pins
 * who may read and write, that no gym can be named, and the body shape.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/emailAlertGymEvents', () => {
  const actual = jest.requireActual('@/src/server/pilot/emailAlertGymEvents');
  return { ...actual, readGymEmailAlertEvents: jest.fn(), setGymEmailAlertEvent: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockRead = readGymEmailAlertEvents as jest.Mock;
const mockSet = setGymEmailAlertEvent as jest.Mock;

const URL = 'http://localhost/api/pilot/email-alerts/gym';
const EVENTS = [{ user_type: 'staff', event_kind: 'gym_notice', ticked: true, is_default: true }];

function principal(role: string) {
  return { accountId: `acct-${role}`, role, organizationId: 'org-1', athleteId: null, sessionToken: 'secret', authProvider: 'microsoft' };
}

function put(body: unknown, url = URL) {
  return PUT(new NextRequest(url, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockResolvedValue(EVENTS);
  mockSet.mockImplementation(async (input: { userType: string; eventKind: string; ticked: boolean }) => (
    { user_type: input.userType, event_kind: input.eventKind, ticked: input.ticked, is_default: false }));
});

const REFUSED = ['coach', 'parent', 'athlete', 'staff', 'volunteer', 'board', 'platform_owner'];

describe('GET', () => {
  it.each(['organization_admin', 'admin'])('the gym admin (%s) reads its own gym\'s choices', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await GET(new NextRequest(URL));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, events: EVENTS });
    expect(mockRead).toHaveBeenCalledWith('org-1');
  });

  it.each(REFUSED)('a %s is refused before anything is read', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await GET(new NextRequest(URL));
    expect(response.status).toBe(403);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('refuses a query that names a gym', async () => {
    mockPrincipal.mockResolvedValue(principal('organization_admin'));
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
  it.each(['organization_admin', 'admin'])('the gym admin (%s) ticks one event for its own gym', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await put({ user_type: 'parent', event_kind: 'family_note', ticked: false });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true, event: { user_type: 'parent', event_kind: 'family_note', ticked: false, is_default: false },
    });
    expect(mockSet).toHaveBeenCalledWith({
      organizationId: 'org-1', actorAccountId: `acct-${role}`, actorRole: role,
      userType: 'parent', eventKind: 'family_note', ticked: false,
    });
  });

  it.each(REFUSED)('a %s cannot change it', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await put({ user_type: 'parent', event_kind: 'family_note', ticked: false });
    expect(response.status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it.each([
    ['no body', ''],
    ['an array', [{ user_type: 'parent', event_kind: 'family_note', ticked: false }]],
    ['a missing field', { user_type: 'parent', event_kind: 'family_note' }],
    ['a field naming another gym', { user_type: 'parent', event_kind: 'family_note', ticked: false, organization_id: 'org-2' }],
    ['a key that joins two field names', { 'event_kind,ticked': 1, user_type: 'staff' }],
    ['a field twice over under another name', { user_type: 'parent', event_kind: 'family_note', Ticked: false }],
  ])('refuses %s without writing', async (_label, body) => {
    mockPrincipal.mockResolvedValue(principal('organization_admin'));
    const response = await put(body);
    expect(response.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('refuses a query field on the write', async () => {
    mockPrincipal.mockResolvedValue(principal('organization_admin'));
    const response = await put({ user_type: 'parent', event_kind: 'family_note', ticked: false }, `${URL}?organization_id=org-2`);
    expect(response.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('passes an event off the list through for the module to refuse', async () => {
    mockPrincipal.mockResolvedValue(principal('organization_admin'));
    mockSet.mockImplementation(jest.requireActual('@/src/server/pilot/emailAlertGymEvents').setGymEmailAlertEvent);
    const response = await put({ user_type: 'staff', event_kind: 'family_note', ticked: false });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/on that user type's list/);
  });
});
