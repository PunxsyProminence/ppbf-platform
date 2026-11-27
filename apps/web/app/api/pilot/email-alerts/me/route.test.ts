import { NextRequest } from 'next/server';

import { GET, PUT } from './route';
import {
  emailAlertUserTypeFor,
  readEmailAlertSwitch,
  refuseUnlessOffered,
  setEmailAlertSwitch,
} from '@/src/server/pilot/emailAlertSwitches';
import { ForbiddenError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';

/*
 * The caller's own email alert switch route (lane W4-1, EM-1; OW27-10 A,
 * OW27-02 C). The database half, including the age rule and the adult
 * athlete's address rule, is emailAlertSwitches.pg.test.ts; this file pins who
 * may call, that the request can name nobody else, the body shape, and (L1)
 * that whether a switch is offered is asked before the query or body is judged.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/emailAlertSwitches', () => {
  const actual = jest.requireActual('@/src/server/pilot/emailAlertSwitches');
  return {
    ...actual,
    emailAlertUserTypeFor: jest.fn(),
    refuseUnlessOffered: jest.fn(),
    readEmailAlertSwitch: jest.fn(),
    setEmailAlertSwitch: jest.fn(),
  };
});

// For the one test that runs the real setEmailAlertSwitch: a parent with no athlete record linked.
jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => ({ athlete_id: null })),
  withTransaction: jest.fn(async () => {
    throw new Error('test bug: no write is reached here');
  }),
}));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockRead = readEmailAlertSwitch as jest.Mock;
const mockSet = setEmailAlertSwitch as jest.Mock;
const mockType = emailAlertUserTypeFor as jest.Mock;
const mockOffered = refuseUnlessOffered as jest.Mock;
const NOT_OFFERED = 'Forbidden: email alerts are not offered to this account';

const URL = 'http://localhost/api/pilot/email-alerts/me';

function principal(role: string, athleteId: string | null = null) {
  return { accountId: `acct-${role}`, role, organizationId: 'org-1', athleteId, sessionToken: 'secret', authProvider: 'magic_link' };
}

function put(body: unknown, url = URL) {
  return PUT(new NextRequest(url, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockType.mockResolvedValue('staff');
  mockOffered.mockResolvedValue(undefined);
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
    expect(mockType).toHaveBeenCalledTimes(2);
    expect(mockRead).not.toHaveBeenCalled();
  });

  // L1 (a reviewer on EM-2b-2): whether a switch is offered is asked before the
  // query is judged, so a caller offered none gets the same answer whatever it sent.
  it('a caller offered no switch gets the same { offered: false } with or without a query', async () => {
    mockPrincipal.mockResolvedValue(principal('athlete', 'ath-minor'));
    mockType.mockResolvedValue(null);
    mockRead.mockResolvedValue({ offered: false });
    const answers = [];
    for (const query of ['', '?account_id=acct-other', '?x=']) {
      const response = await GET(new NextRequest(`${URL}${query}`));
      answers.push({ status: response.status, headers: [...response.headers.entries()], body: await response.text() });
    }
    expect(answers[0]).toMatchObject({ status: 200, body: JSON.stringify({ ok: true, offered: false }) });
    expect(answers).toEqual([answers[0], answers[0], answers[0]]);
    expect(mockRead).toHaveBeenCalledTimes(3);
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
    // Offered: the check passed first, then the shape was judged.
    expect(mockOffered).toHaveBeenCalledTimes(1);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('refuses a query field on the write', async () => {
    mockPrincipal.mockResolvedValue(principal('parent'));
    const response = await put({ switched_on: true }, `${URL}?account_id=acct-other`);
    expect(response.status).toBe(400);
    expect(mockOffered).toHaveBeenCalledTimes(1);
    expect(mockSet).not.toHaveBeenCalled();
  });

  // L1 (a reviewer on EM-2b-2): the request is read in full, then whether a
  // switch is offered is asked, then the shape is judged, so a caller offered
  // none gets the store's one plain 403 whatever it sent.
  it('a caller offered no switch gets the same plain 403 for a query field, any malformed body and a well-formed one', async () => {
    mockPrincipal.mockResolvedValue(principal('athlete', 'ath-minor'));
    let current: NextRequest | null = null;
    const readFirst: boolean[] = [];
    mockOffered.mockImplementation(async () => {
      readFirst.push(current!.bodyUsed);
      throw new ForbiddenError(NOT_OFFERED);
    });
    const sends: Array<[string, unknown, string]> = [
      ['well-formed', { switched_on: true }, URL],
      ['a query field', { switched_on: true }, `${URL}?account_id=acct-other`],
      ['no body', '', URL],
      ['not JSON', '{"', URL],
      ['an array', [true], URL],
      ['a different field', { on: true }, URL],
      ['a second field', { switched_on: true, account_id: 'acct-other' }, URL],
      ['a non-boolean', { switched_on: 'yes' }, URL],
    ];
    const answers = [];
    for (const [label, body, url] of sends) {
      const request = new NextRequest(url, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) });
      current = request;
      const response = await PUT(request);
      answers.push({ label, status: response.status, headers: [...response.headers.entries()], body: await response.text() });
    }
    const plain = { status: 403, headers: answers[0].headers, body: JSON.stringify({ error: NOT_OFFERED }) };
    expect(answers).toEqual(sends.map(([label]) => ({ label, ...plain })));
    expect(readFirst).toEqual(sends.map(() => true));
    for (const call of mockOffered.mock.calls) {
      expect(call[0]).toEqual({ organizationId: 'org-1', accountId: 'acct-athlete', role: 'athlete', athleteId: 'ath-minor' });
    }
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
