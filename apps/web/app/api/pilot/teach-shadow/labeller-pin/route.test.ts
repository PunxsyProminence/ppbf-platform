/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

import { DELETE, GET, PUT } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { ConflictError, ForbiddenError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  clearLabellerCredential,
  getOwnLabellerCredential,
  setOwnLabellerCredential,
} from '@/src/server/pilot/labellerCredentials';

/*
  What the ROUTE adds: the session gate, the role gate per verb, and that
  every id it writes is the caller's own (or, for a clear, inside the caller's
  own organization). The writes themselves are proven against real Postgres
  in labellerCredentials.pg.test.ts.
*/

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/labellerCredentials', () => ({
  ...jest.requireActual('@/src/server/pilot/labellerCredentials'),
  clearLabellerCredential: jest.fn(async () => true),
  getOwnLabellerCredential: jest.fn(async () => null),
  setOwnLabellerCredential: jest.fn(async () => undefined),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(async () => undefined),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockSet = jest.mocked(setOwnLabellerCredential);
const mockClear = jest.mocked(clearLabellerCredential);
const mockGet = jest.mocked(getOwnLabellerCredential);
const mockAudit = jest.mocked(writePilotAuditEvent);

function principal(role: PilotPrincipal['role'], accountId = 'coach-a'): PilotPrincipal {
  return {
    accountId,
    role,
    organizationId: 'org-pp',
    athleteId: null,
    sessionToken: 'session-token',
    authProvider: 'microsoft',
  };
}

function request(method: string, body?: unknown) {
  return new NextRequest('http://localhost/api/pilot/teach-shadow/labeller-pin', {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('PUT: set my own labelling PIN', () => {
  it('writes the caller\'s own ids and ignores any account named in the body', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    const response = await PUT(request('PUT', {
      display_name: 'Coach A',
      pin: '2580',
      account_id: 'coach-b',
      organization_id: 'org-other',
    }));
    expect(response.status).toBe(200);
    expect(mockSet).toHaveBeenCalledWith({
      organizationId: 'org-pp',
      accountId: 'coach-a',
      displayName: 'Coach A',
      pin: '2580',
    });
  });

  it('audits the change without the PIN', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin', 'admin-a'));
    await PUT(request('PUT', { display_name: 'Admin A', pin: '2580' }));
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const event = mockAudit.mock.calls[0][0];
    expect(event).toMatchObject({
      actor_account_id: 'admin-a',
      entity_type: 'labeller_credential',
      entity_id: 'admin-a',
      shadow_mirror: false,
    });
    expect(JSON.stringify(event)).not.toContain('2580');
  });

  it.each(['athlete', 'parent', 'staff', 'volunteer', 'platform_owner'] as const)('refuses a %s', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    const response = await PUT(request('PUT', { display_name: 'X', pin: '2580' }));
    expect(response.status).toBe(403);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('refuses without a session', async () => {
    mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));
    const response = await PUT(request('PUT', { display_name: 'X', pin: '2580' }));
    expect(response.status).toBe(401);
    expect(mockSet).not.toHaveBeenCalled();
  });

  it('passes a rule refusal through as a 400 the page can show', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockSet.mockImplementationOnce(jest.requireActual('@/src/server/pilot/labellerCredentials').setOwnLabellerCredential);
    const response = await PUT(request('PUT', { display_name: 'Coach A', pin: '12345' }));
    expect(response.status).toBe(400);
    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('PUT and DELETE: what each refusal reaches the page as', () => {
  it.each([
    ['a taken name', new ConflictError('Another labeller in this gym already uses that name', 'LABELLER_NAME_TAKEN'), 409],
    ['an ineligible account', new ForbiddenError('Only an active coach or organization admin', 'LABELLER_NOT_ELIGIBLE'), 403],
  ])('%s', async (_label, error, status) => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockSet.mockRejectedValueOnce(error);
    const response = await PUT(request('PUT', { display_name: 'Coach A', pin: '2580' }));
    expect(response.status).toBe(status);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it.each([['null', 'null'], ['an array', '[1]'], ['not JSON', '{']])('a PUT body that is %s is a 400, not a 500', async (_label, raw) => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockSet.mockImplementationOnce(jest.requireActual('@/src/server/pilot/labellerCredentials').setOwnLabellerCredential);
    const response = await PUT(new NextRequest('http://localhost/api/pilot/teach-shadow/labeller-pin', {
      method: 'PUT', body: raw, headers: { 'content-type': 'application/json' },
    }));
    expect(response.status).toBe(400);
  });

  it('a DELETE body of null is a 400, not a 500', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
    const response = await DELETE(new NextRequest('http://localhost/api/pilot/teach-shadow/labeller-pin', {
      method: 'DELETE', body: 'null', headers: { 'content-type': 'application/json' },
    }));
    expect(response.status).toBe(400);
    expect(mockClear).not.toHaveBeenCalled();
  });
});

describe('GET: do I have one', () => {
  it('answers with the name and never a hash', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockGet.mockResolvedValueOnce({ display_name: 'Coach A', set_at: new Date('2026-10-03T12:00:00Z') });
    const response = await GET(request('GET'));
    const body = await response.json();
    expect(body).toEqual({ has_pin: true, display_name: 'Coach A', set_at: '2026-10-03T12:00:00.000Z' });
    expect(mockGet).toHaveBeenCalledWith('org-pp', 'coach-a');
  });

  it('refuses a non-labeller', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('parent'));
    expect((await GET(request('GET'))).status).toBe(403);
  });
});

describe('DELETE: an organization admin clears a member\'s PIN', () => {
  it('clears inside the admin\'s own organization only', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin', 'admin-a'));
    const response = await DELETE(request('DELETE', { account_id: 'coach-b', organization_id: 'org-other' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, cleared: true });
    expect(mockClear).toHaveBeenCalledWith({ organizationId: 'org-pp', actorAccountId: 'admin-a', accountId: 'coach-b' });
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      actor_account_id: 'admin-a',
      entity_id: 'coach-b',
      details: { action: 'clear_labelling_pin' },
    });
  });

  it('admits the legacy admin alias', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('admin', 'legacy-admin'));
    expect((await DELETE(request('DELETE', { account_id: 'coach-b' }))).status).toBe(200);
  });

  it.each(['coach', 'platform_owner', 'staff'] as const)('refuses a %s', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    const response = await DELETE(request('DELETE', { account_id: 'coach-b' }));
    expect(response.status).toBe(403);
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('refuses a missing account_id', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
    expect((await DELETE(request('DELETE', {}))).status).toBe(400);
    expect(mockClear).not.toHaveBeenCalled();
  });

  it('writes no audit row when there was nothing to clear', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
    mockClear.mockResolvedValueOnce(false);
    const response = await DELETE(request('DELETE', { account_id: 'coach-b' }));
    expect(await response.json()).toEqual({ ok: true, cleared: false });
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
