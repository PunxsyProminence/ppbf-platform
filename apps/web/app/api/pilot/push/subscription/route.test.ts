import { NextRequest } from 'next/server';

import { DELETE, GET, POST, PUT } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { isPushOnHere, readPushOffer, removePushBrowser, savePushBrowser } from '@/src/server/pilot/pushSubscriptions';

/*
 * The caller's own web push browsers (lane W5-WP, WP-1b; the GO on #2228
 * approved this role line by name). The database half, the age rule and the
 * endpoint rules are pushSubscriptions.pg.test.ts and pushSubscriptions.test.ts;
 * this file pins who may call, that the request can name nobody else, and that
 * nothing reaches the store from the URL.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/pushSubscriptions', () => ({
  readPushOffer: jest.fn(),
  isPushOnHere: jest.fn(),
  savePushBrowser: jest.fn(),
  removePushBrowser: jest.fn(),
}));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockOffer = readPushOffer as jest.Mock;
const mockCheck = isPushOnHere as jest.Mock;
const mockSave = savePushBrowser as jest.Mock;
const mockRemove = removePushBrowser as jest.Mock;

const URL = 'http://localhost/api/pilot/push/subscription';
const BODY = { endpoint: 'https://push.example.test/send/one', keys: { p256dh: 'p', auth: 'a' } };

function principal(role: string, athleteId: string | null = null) {
  return { accountId: `acct-${role}`, role, organizationId: 'org-1', athleteId, sessionToken: 'secret', authProvider: 'magic_link' };
}

function call(method: 'GET' | 'POST' | 'PUT' | 'DELETE', body?: unknown, url = URL) {
  const handler = { GET, POST, PUT, DELETE }[method];
  const init = body === undefined ? { method } : { method, body: JSON.stringify(body) };
  return handler(new NextRequest(url, init));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockOffer.mockResolvedValue({ offered: true, public_key: 'pub' });
  mockCheck.mockResolvedValue({ on: true });
  mockSave.mockResolvedValue({ on: true });
  mockRemove.mockResolvedValue({ on: false });
});

const ADMITTED = ['coach', 'organization_admin', 'admin', 'parent', 'athlete'];
const REFUSED = ['staff', 'volunteer', 'board', 'platform_owner'];
const METHODS = ['GET', 'POST', 'PUT', 'DELETE'] as const;
const STORE = { GET: mockOffer, POST: mockCheck, PUT: mockSave, DELETE: mockRemove };

describe.each(METHODS)('%s', (method) => {
  const body = method === 'GET' ? undefined : method === 'PUT' ? BODY : { endpoint: BODY.endpoint };

  it.each(ADMITTED)('a signed-in %s reaches the store as itself, from the session only', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role, role === 'athlete' ? 'ath-1' : null));
    const response = await call(method, body);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(STORE[method]).toHaveBeenCalledTimes(1);
    expect(STORE[method].mock.calls[0][0]).toEqual({
      organizationId: 'org-1',
      accountId: `acct-${role}`,
      role,
      athleteId: role === 'athlete' ? 'ath-1' : null,
    });
    if (method !== 'GET') expect(STORE[method].mock.calls[0][1]).toEqual(body);
  });

  it.each(REFUSED)('a %s is refused before the store is reached', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await call(method, body);
    expect(response.status).toBe(403);
    expect(STORE[method]).not.toHaveBeenCalled();
  });

  it('refuses any query field, so the URL can name nobody and carry no endpoint', async () => {
    mockPrincipal.mockResolvedValue(principal('parent'));
    const response = await call(method, body, `${URL}?account_id=someone-else`);
    expect(response.status).toBe(400);
    expect(STORE[method]).not.toHaveBeenCalled();
  });

  it('a request with no session is refused', async () => {
    mockPrincipal.mockRejectedValue(new Error('Unauthorized'));
    const response = await call(method, body);
    expect(response.status).toBe(401);
    expect(STORE[method]).not.toHaveBeenCalled();
  });
});

it('the store\'s refusal of someone not offered push comes back as 403', async () => {
  mockPrincipal.mockResolvedValue(principal('athlete', 'ath-minor'));
  const { ForbiddenError } = jest.requireActual('@/src/server/pilot/errors');
  mockSave.mockRejectedValue(new ForbiddenError('Forbidden: web push is not offered to this account'));
  const response = await call('PUT', BODY);
  expect(response.status).toBe(403);
});

it('a body that is not JSON reaches the store as null, which refuses it', async () => {
  mockPrincipal.mockResolvedValue(principal('parent'));
  await PUT(new NextRequest(URL, { method: 'PUT', body: 'not json' }));
  expect(mockSave.mock.calls[0][1]).toBeNull();
});
