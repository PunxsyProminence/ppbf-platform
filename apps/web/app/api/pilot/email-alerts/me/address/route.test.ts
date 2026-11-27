import { NextRequest } from 'next/server';

import * as route from './route';
import { emailAlertCodeMailer } from '@/src/server/pilot/emailAlertCode';
import {
  confirmEmailAlertAddress,
  emailAlertCodeLimitError,
  requestEmailAlertAddressCode,
} from '@/src/server/pilot/emailAlertSwitches';
import { ConflictError, ForbiddenError, ServiceUnavailableError, ValidationError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';

/*
 * An adult athlete's alert address route (lane W4-1, EM-2b-2; plan on #2159,
 * section 8; OW27-38 B, OW27-02 C). The store is mocked: this file pins who may
 * call, that the request names nobody else, the body shape, and that every
 * answer is the store's, mapped without an address in it. The adult check,
 * the limits, the tries and the races are emailAlertAddress.pg.test.ts.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/emailAlertSwitches', () => {
  const actual = jest.requireActual('@/src/server/pilot/emailAlertSwitches');
  return { ...actual, requestEmailAlertAddressCode: jest.fn(), confirmEmailAlertAddress: jest.fn() };
});

const mailer = jest.fn();
jest.mock('@/src/server/pilot/emailAlertCode', () => ({ emailAlertCodeMailer: jest.fn(() => mailer) }));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockRequest = requestEmailAlertAddressCode as jest.Mock;
const mockConfirm = confirmEmailAlertAddress as jest.Mock;

const URL = 'http://localhost/api/pilot/email-alerts/me/address';
const ADDRESS = 'adult.person@example.test';
const SENT = { offered: true, user_type: 'adult_athlete', switched_on: false, address_confirmed: false, code_pending: true };
const CONFIRMED = { offered: true, user_type: 'adult_athlete', switched_on: false, address_confirmed: true, code_pending: false };

function principal(role: string, athleteId: string | null = null) {
  return { accountId: `acct-${role}`, role, organizationId: 'org-1', athleteId, sessionToken: 'secret', authProvider: 'ppbf_local' };
}

function send(method: 'POST' | 'PUT', body: unknown, url = URL) {
  const request = new NextRequest(url, { method, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return method === 'POST' ? route.POST(request) : route.PUT(request);
}

const athlete = () => mockPrincipal.mockResolvedValue(principal('athlete', 'ath-1'));

beforeEach(() => {
  jest.clearAllMocks();
  mockRequest.mockResolvedValue(SENT);
  mockConfirm.mockResolvedValue(CONFIRMED);
});

it('has no DELETE, and no handler but POST and PUT', () => {
  expect(Object.keys(route).filter((name) => /^[A-Z]+$/.test(name)).sort()).toEqual(['POST', 'PUT']);
});

it('POST: an athlete asks for a code to the address typed, with the session as the only subject; the answer holds no address', async () => {
  athlete();
  const response = await send('POST', { address: ADDRESS });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ ok: true, ...SENT });
  expect(text).not.toContain('@');
  expect(mockRequest).toHaveBeenCalledWith(
    { organizationId: 'org-1', accountId: 'acct-athlete', role: 'athlete', athleteId: 'ath-1', address: ADDRESS },
    mailer,
  );
  expect(emailAlertCodeMailer).toHaveBeenCalledTimes(1);
});

it('PUT: an athlete enters the code, with the session as the only subject; the answer holds no address', async () => {
  athlete();
  const response = await send('PUT', { code: '012345' });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({ ok: true, ...CONFIRMED });
  expect(text).not.toContain('@');
  expect(mockConfirm).toHaveBeenCalledWith({
    organizationId: 'org-1', accountId: 'acct-athlete', role: 'athlete', athleteId: 'ath-1', code: '012345',
  });
});

describe.each(['POST', 'PUT'] as const)('%s', (method) => {
  const body = method === 'POST' ? { address: ADDRESS } : { code: '012345' };
  const field = method === 'POST' ? 'address' : 'code';
  const store = () => (method === 'POST' ? mockRequest : mockConfirm);

  it('a caller with no session is refused before anything is read', async () => {
    mockPrincipal.mockRejectedValue(new Error('Unauthorized'));
    expect((await send(method, body)).status).toBe(401);
    expect(store()).not.toHaveBeenCalled();
  });

  it.each(['coach', 'organization_admin', 'admin', 'parent', 'staff', 'volunteer', 'board', 'platform_owner'])(
    'a %s is refused before anything is read',
    async (role) => {
      mockPrincipal.mockResolvedValue(principal(role));
      expect((await send(method, body)).status).toBe(403);
      expect(store()).not.toHaveBeenCalled();
      expect(emailAlertCodeMailer).not.toHaveBeenCalled();
    },
  );

  // L1: the route's own refusals say nothing about email; the worded ones are the store's, after its adult check.
  it.each([
    ['no body', ''],
    ['an array', [body]],
    ['a missing field', {}],
    ['a second field naming another account', { ...body, account_id: 'acct-other' }],
    ['a second field naming another gym', { ...body, organization_id: 'org-2' }],
    ['the other route\'s field', method === 'POST' ? { code: '012345' } : { address: ADDRESS }],
    ['a number for the string', { [field]: 12345 }],
    ['null for the string', { [field]: null }],
  ])('refuses %s without calling the store, naming nothing about email', async (_label, sent) => {
    athlete();
    const response = await send(method, sent);
    expect(response.status).toBe(400);
    expect((await response.json()).error).not.toMatch(/email|address|code|six/i);
    expect(store()).not.toHaveBeenCalled();
  });

  it.each(['account_id=acct-other', 'organization_id=org-2', 'athlete_id=ath-2'])('refuses the query %s', async (query) => {
    athlete();
    const response = await send(method, body, `${URL}?${query}`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).not.toMatch(/email|address|code/i);
    expect(store()).not.toHaveBeenCalled();
  });

  it('an athlete the store does not offer a switch (under 18, no date of birth, record gone) gets its 403', async () => {
    athlete();
    store().mockRejectedValue(new ForbiddenError('Forbidden: email alerts are not offered to this account'));
    const response = await send(method, body);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden: email alerts are not offered to this account' });
  });
});

it('POST: every limit is the store\'s one 429, answered the same, naming no limit and no address', async () => {
  athlete();
  const answers = [];
  for (let i = 0; i < 3; i += 1) {
    mockRequest.mockRejectedValueOnce(emailAlertCodeLimitError());
    const response = await send('POST', { address: ADDRESS });
    answers.push({ status: response.status, headers: [...response.headers.entries()], body: await response.text() });
  }
  expect(answers[0].status).toBe(429);
  expect(answers[1]).toEqual(answers[0]);
  expect(answers[2]).toEqual(answers[0]);
  expect(JSON.parse(answers[0].body)).toEqual({ error: emailAlertCodeLimitError().message, code: 'EMAIL_ALERT_CODE_LIMIT' });
  expect(answers[0].body).not.toContain('@');
});

it('POST: a code email that could not be sent is a 503 with no address in it', async () => {
  athlete();
  mockRequest.mockRejectedValue(new ServiceUnavailableError('The code email could not be sent. Try again in a few minutes.', 'EMAIL_ALERT_CODE_NOT_SENT'));
  const response = await send('POST', { address: ADDRESS });
  expect(response.status).toBe(503);
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({ code: 'EMAIL_ALERT_CODE_NOT_SENT' });
  expect(text).not.toContain('@');
});

it.each(['EMAIL_ALERT_CODE_WRONG', 'EMAIL_ALERT_CODE_EXPIRED', 'EMAIL_ALERT_CODE_TRIES_USED'])(
  'PUT: a %s refusal is a 409 carrying its code',
  async (code) => {
    athlete();
    mockConfirm.mockRejectedValue(new ConflictError('That code cannot be used.', code));
    const response = await send('PUT', { code: '012345' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'That code cannot be used.', code });
  },
);

it('passes a malformed address and code through unjudged: the store answers after its adult check', async () => {
  athlete();
  mockRequest.mockRejectedValueOnce(new ValidationError('Enter a valid email address'));
  mockConfirm.mockRejectedValueOnce(new ValidationError('Enter the six-digit code from the email'));
  const posted = await send('POST', { address: 'not an address' });
  expect(posted.status).toBe(400);
  expect(await posted.json()).toEqual({ error: 'Enter a valid email address' });
  expect(mockRequest.mock.calls[0][0]).toMatchObject({ address: 'not an address' });
  const put = await send('PUT', { code: '12' });
  expect(put.status).toBe(400);
  expect(mockConfirm.mock.calls[0][0]).toMatchObject({ code: '12' });
  expect(mailer).not.toHaveBeenCalled();
});
