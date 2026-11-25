import { NextRequest } from 'next/server';

import { GET, PUT } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { readStoppedComingPolicy, setStoppedComingPolicy } from '@/src/server/pilot/stoppedComingPolicy';

/*
 * The stopped-coming number-of-days route (lane W4-6, SC-0a; OW27-30 A;
 * Overwatch's W4-6 answer Q6 A: the gym admin only reads it). The database
 * half is stoppedComingPolicy.pg.test.ts; this file pins who may read and who
 * may set.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/stoppedComingPolicy', () => {
  const actual = jest.requireActual('@/src/server/pilot/stoppedComingPolicy');
  return { ...actual, readStoppedComingPolicy: jest.fn(), setStoppedComingPolicy: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockRead = readStoppedComingPolicy as jest.Mock;
const mockSet = setStoppedComingPolicy as jest.Mock;

const URL = 'http://localhost/api/pilot/stopped-coming/gap';
const CHOICES = [7, 14, 21, 28, 42, 56];
const NOT_THE_GYM_ADMIN = ['platform_owner', 'coach', 'athlete', 'parent', 'board', 'volunteer', 'staff'];

function principal(role: string, organizationId = 'org-1') {
  return { accountId: `acct-${role}`, role, organizationId, athleteId: null, sessionToken: 'secret', authProvider: 'microsoft' };
}

function put(body: unknown) {
  return PUT(new NextRequest(URL, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRead.mockResolvedValue({ gap_days: 14, is_default: true });
  mockSet.mockImplementation(async (input: { gapDays: number | null }) =>
    input.gapDays === null ? { gap_days: 14, is_default: true } : { gap_days: input.gapDays, is_default: false });
});

describe('GET', () => {
  it.each(['organization_admin', 'admin'])('the gym admin (%s) reads its own gym\'s number, the default flag and the choices', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await GET(new NextRequest(URL));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ ok: true, gap_days: 14, is_default: true, choices: CHOICES });
    expect(mockRead).toHaveBeenCalledWith('org-1');
  });

  it.each(NOT_THE_GYM_ADMIN)('a %s is refused before anything is read', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await GET(new NextRequest(URL));
    expect(response.status).toBe(403);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it('reads the organization from the session, and refuses a query that names one', async () => {
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
  it.each(['organization_admin', 'admin'])('the gym admin (%s) sets the number for its own gym', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await put({ gap_days: 28 });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ ok: true, gap_days: 28, is_default: false, choices: CHOICES });
    expect(mockSet).toHaveBeenCalledWith({ organizationId: 'org-1', actorAccountId: `acct-${role}`, actorRole: role, gapDays: 28 });
  });

  it('null puts the default back ("Use the default")', async () => {
    mockPrincipal.mockResolvedValue(principal('organization_admin'));
    const response = await put({ gap_days: null });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ ok: true, gap_days: 14, is_default: true, choices: CHOICES });
    expect(mockSet).toHaveBeenCalledWith(expect.objectContaining({ gapDays: null }));
  });

  it.each(['coach', 'athlete'])('a %s sending a broken body is refused for its role (403), not for its body', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    for (const body of ['not json', [14], { gap_days: 30, extra: true }]) {
      const response = await put(body);
      expect(response.status).toBe(403);
    }
    expect(mockSet).not.toHaveBeenCalled();
  });

  it.each(NOT_THE_GYM_ADMIN)('a %s cannot change it', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await put({ gap_days: 7 });
    expect(response.status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it.each([
    ['no body', ''],
    ['an array', [14]],
    ['an empty object', {}],
    ['a second field', { gap_days: 14, organization_id: 'org-2' }],
    ['a different field', { days: 14 }],
  ])('refuses %s without writing', async (_label, body) => {
    mockPrincipal.mockResolvedValue(principal('organization_admin'));
    const response = await put(body);
    expect(response.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('refuses a query field on the write, so no request can name a gym', async () => {
    mockPrincipal.mockResolvedValue(principal('organization_admin'));
    const response = await PUT(new NextRequest(`${URL}?organization_id=org-2`, { method: 'PUT', body: JSON.stringify({ gap_days: 14 }) }));
    expect(response.status).toBe(400);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('passes the value through for the module to refuse a number off the list', async () => {
    mockPrincipal.mockResolvedValue(principal('organization_admin'));
    mockSet.mockImplementation(jest.requireActual('@/src/server/pilot/stoppedComingPolicy').setStoppedComingPolicy);
    const response = await put({ gap_days: 30 });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/7, 14, 21, 28, 42, 56/);
  });
});
