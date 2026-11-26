import { NextRequest } from 'next/server';

import { GET, PUT } from './route';
import { readEmailAlertSwitch, setEmailAlertSwitch } from '@/src/server/pilot/emailAlertSwitches';
import { requirePrincipal } from '@/src/server/pilot/http';

/*
 * The caller's own email alert switch route (lane W4-1, EM-1; OW27-10 A,
 * OW27-02 C). The database half, including the age rule and the adult
 * athlete's address rule, is emailAlertSwitches.pg.test.ts; this file pins who
 * may call, that the request can name nobody else, and the body shape.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/emailAlertSwitches', () => {
  const actual = jest.requireActual('@/src/server/pilot/emailAlertSwitches');
  return { ...actual, readEmailAlertSwitch: jest.fn(), setEmailAlertSwitch: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockRead = readEmailAlertSwitch as jest.Mock;
const mockSet = setEmailAlertSwitch as jest.Mock;

const URL = 'http://localhost/api/pilot/email-alerts/me';

function principal(role: string, athleteId: string | null = null) {
  return { accountId: `acct-${role}`, role, organizationId: 'org-1', athleteId, sessionToken: 'secret', authProvider: 'magic_link' };
}

function put(body: unknown, url = URL) {
  return PUT(new NextRequest(url, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockResolvedValue({ offered: true, user_type: 'staff', switched_on: false });
  mockSet.mockImplementation(async (input: { switchedOn: boolean }) => ({ offered: true, user_type: 'staff', switched_on: input.switchedOn }));
});

const ADMITTED = ['coach', 'organization_admin', 'admin', 'parent', 'athlete'];
const REFUSED = ['staff', 'volunteer', 'board', 'platform_owner'];

describe('GET', () => {
  it.each(ADMITTED)('a signed-in %s reads only its own switch', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role, role === 'athlete' ? 'ath-1' : null));
    const response = await GET(new NextRequest(URL));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, offered: true, user_type: 'staff', switched_on: false });
    expect(mockRead).toHaveBeenCalledWith({
      organizationId: 'org-1',
      accountId: `acct-${role}`,
      role,
      athleteId: role === 'athlete' ? 'ath-1' : null,
    });
  });

  it.each(REFUSED)('a %s has no switch and is refused before anything is read', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await GET(new NextRequest(URL));
    expect(response.status).toBe(403);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('an athlete the store does not offer a switch gets { offered: false } and nothing else', async () => {
    mockPrincipal.mockResolvedValue(principal('athlete', 'ath-minor'));
    mockRead.mockResolvedValue({ offered: false });
    const response = await GET(new NextRequest(URL));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, offered: false });
  });

  it('refuses a query that names an account or a gym', async () => {
    mockPrincipal.mockResolvedValue(principal('parent'));
    for (const query of ['account_id=acct-other', 'organization_id=org-2']) {
      const response = await GET(new NextRequest(`${URL}?${query}`));
      expect(response.status).toBe(400);
    }
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
  it.each(ADMITTED)('a %s switches its own email alert, with the session as the only subject', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role, role === 'athlete' ? 'ath-1' : null));
    const response = await put({ switched_on: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, offered: true, user_type: 'staff', switched_on: true });
    expect(mockSet).toHaveBeenCalledWith({
      organizationId: 'org-1',
      accountId: `acct-${role}`,
      role,
      athleteId: role === 'athlete' ? 'ath-1' : null,
      switchedOn: true,
    });
  });

  it.each(REFUSED)('a %s cannot switch anything', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await put({ switched_on: true });
    expect(response.status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it.each([
    ['no body', ''],
    ['an array', [true]],
    ['a second field naming another account', { switched_on: true, account_id: 'acct-other' }],
    ['a different field', { on: true }],
  ])('refuses %s without writing', async (_label, body) => {
    mockPrincipal.mockResolvedValue(principal('parent'));
    const response = await put(body);
    expect(response.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('refuses a query field on the write', async () => {
    mockPrincipal.mockResolvedValue(principal('parent'));
    const response = await put({ switched_on: true }, `${URL}?account_id=acct-other`);
    expect(response.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('passes a non-boolean through for the module to refuse', async () => {
    mockPrincipal.mockResolvedValue(principal('parent'));
    mockSet.mockImplementation(jest.requireActual('@/src/server/pilot/emailAlertSwitches').setEmailAlertSwitch);
    const response = await put({ switched_on: 'yes' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/true or false/);
  });
});
