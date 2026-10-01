/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

import { POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { ForbiddenError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';
import { setOwnPasswordFromLinkSession } from '@/src/server/pilot/parentPassword';
import { validatePasswordPolicy } from '@/src/server/pilot/passwordPolicy';

/*
  What the ROUTE adds to parentPassword.ts: the session gate, the attempt
  limit, the status each refusal reaches the page with, and the audit row.
  Who may set a password, and on what proof, is proven against real Postgres
  in parentPassword.pg.test.ts.
*/

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/parentPassword', () => ({
  setOwnPasswordFromLinkSession: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(async () => undefined),
}));

// PPBF_DURABLE_RATE_LIMIT is unset in the test env, so the durable helpers
// fall through to the real in-memory limiter with no database touch.
jest.mock('@/src/server/pilot/rateLimit', () => {
  const actual = jest.requireActual('@/src/server/pilot/rateLimit');
  return {
    ...actual,
    getClientIp: () => '203.0.113.9',
    checkDurableRateLimit: jest.fn(actual.checkDurableRateLimit),
    recordDurableFailedAttempt: jest.fn(actual.recordDurableFailedAttempt),
    clearDurableRateLimit: jest.fn(actual.clearDurableRateLimit),
  };
});

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockSetPassword = jest.mocked(setOwnPasswordFromLinkSession);
const rateLimit = jest.requireMock('@/src/server/pilot/rateLimit') as {
  checkDurableRateLimit: jest.Mock;
  recordDurableFailedAttempt: jest.Mock;
  clearDurableRateLimit: jest.Mock;
  clearRateLimit: (key: string) => void;
  recordFailedAttempt: (key: string) => unknown;
};
const actualRateLimit = jest.requireActual('@/src/server/pilot/rateLimit') as typeof import('@/src/server/pilot/rateLimit');

const GOOD_PASSWORD = 'three small boats';

function post(body: unknown) {
  return POST(new NextRequest('http://localhost/api/pilot/auth/password/set', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }));
}

function linkRequired(): ForbiddenError {
  return new ForbiddenError(
    'Forbidden: open a new sign-in link from your email to set a password',
    'PASSWORD_SETUP_LINK_REQUIRED',
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  rateLimit.clearRateLimit('password_set_account:parent-1');
  rateLimit.clearRateLimit('password_set_ip:203.0.113.9');
  mockRequirePrincipal.mockResolvedValue({
    accountId: 'parent-1',
    role: 'parent' as const,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'session-token-value',
    authProvider: 'microsoft' as const,
  } as never);
  mockSetPassword.mockResolvedValue(undefined);
  // clearAllMocks keeps implementations; put the real durable check back.
  rateLimit.checkDurableRateLimit.mockImplementation(actualRateLimit.checkDurableRateLimit);
});

describe('POST /api/pilot/auth/password/set', () => {
  test('no session is a 401 and nothing is set', async () => {
    mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));

    const res = await post({ password: GOOD_PASSWORD });

    expect(res.status).toBe(401);
    expect(mockSetPassword).not.toHaveBeenCalled();
  });

  test('the password is set for the session\'s own account, on that session, exactly as typed', async () => {
    const res = await post({ password: `  ${GOOD_PASSWORD} `, account_id: 'someone-else' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // account_id in the body is ignored; the spaces are not trimmed.
    expect(mockSetPassword).toHaveBeenCalledWith({
      accountId: 'parent-1',
      sessionToken: 'session-token-value',
      password: `  ${GOOD_PASSWORD} `,
    });
  });

  test('success writes an audit row that does not carry the password', async () => {
    await post({ password: GOOD_PASSWORD });

    expect(writePilotAuditEvent).toHaveBeenCalledWith({
      event_type: 'update',
      actor_account_id: 'parent-1',
      actor_role: 'parent',
      organization_id: 'org-1',
      entity_type: 'account',
      entity_id: 'parent-1',
      details: { action: 'set_own_password' },
    });
    expect(JSON.stringify(jest.mocked(writePilotAuditEvent).mock.calls)).not.toContain(GOOD_PASSWORD);
  });

  test('a lost audit row does not turn a saved password into an error', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.mocked(writePilotAuditEvent).mockRejectedValueOnce(new Error('audit down'));

    const res = await post({ password: GOOD_PASSWORD });

    expect(res.status).toBe(200);
    error.mockRestore();
  });

  test.each([
    ['a missing password', {}],
    ['an empty password', { password: '' }],
    ['a password that is not a string', { password: 1234567890 }],
    ['a body that is not JSON', 'not json'],
  ])('%s is a 400 and nothing is set', async (_label, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(mockSetPassword).not.toHaveBeenCalled();
  });

  test('a password the rules refuse is a 400 carrying the reason, and is not counted as an attempt', async () => {
    // The real validator decides what is thrown; the route decides the status.
    mockSetPassword.mockImplementation(async ({ password }) => validatePasswordPolicy(password));

    const res = await post({ password: 'password123' });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe('PASSWORD_TOO_GUESSABLE');
    expect(body.error).toContain('too easy to guess');
    expect(rateLimit.recordDurableFailedAttempt).not.toHaveBeenCalled();
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test('a session that is not a fresh emailed-link session is a 403 with the code the page reads, and is counted', async () => {
    mockSetPassword.mockRejectedValue(linkRequired());

    const res = await post({ password: GOOD_PASSWORD });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('PASSWORD_SETUP_LINK_REQUIRED');
    expect(rateLimit.recordDurableFailedAttempt.mock.calls.map(([key]) => key)).toEqual([
      'password_set_account:parent-1',
      'password_set_ip:203.0.113.9',
    ]);
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test('repeated refusals are throttled: the route answers 429 without reaching the password code', async () => {
    mockSetPassword.mockRejectedValue(linkRequired());

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      statuses.push((await post({ password: GOOD_PASSWORD })).status);
    }

    // The limiter blocks for a moment after every recorded refusal, so the
    // second request already waits; none of them gets a 200.
    expect(statuses[0]).toBe(403);
    expect(statuses).toContain(429);
    expect(statuses).not.toContain(200);
    const reached = mockSetPassword.mock.calls.length;
    expect(reached).toBeLessThan(8);
  });

  // Each of the four checks, limited alone while the other three are clear.
  test.each([
    ['the durable account bucket', 'durable', 'password_set_account:parent-1'],
    ['the durable IP bucket', 'durable', 'password_set_ip:203.0.113.9'],
    ['the in-memory account bucket', 'volatile', 'password_set_account:parent-1'],
    ['the in-memory IP bucket', 'volatile', 'password_set_ip:203.0.113.9'],
  ])('%s alone is enough for a 429, before anything else runs', async (_label, store, limitedKey) => {
    if (store === 'durable') {
      rateLimit.checkDurableRateLimit.mockImplementation(async (key: string) => (
        key === limitedKey ? { isLimited: true, delayMs: 30_000 } : { isLimited: false }
      ));
    } else {
      rateLimit.recordFailedAttempt(limitedKey);
    }

    const res = await post({ password: GOOD_PASSWORD });

    expect(res.status).toBe(429);
    expect(mockSetPassword).not.toHaveBeenCalled();
    rateLimit.clearRateLimit(limitedKey);
  });

  test('success clears both buckets', async () => {
    await post({ password: GOOD_PASSWORD });

    expect(rateLimit.clearDurableRateLimit.mock.calls.map(([key]) => key)).toEqual([
      'password_set_account:parent-1',
      'password_set_ip:203.0.113.9',
    ]);
  });

  test('an unexpected failure is a 500 that says nothing', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockSetPassword.mockRejectedValue(new Error('connection string postgres://secret'));

    const res = await post({ password: GOOD_PASSWORD });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    error.mockRestore();
  });
});
