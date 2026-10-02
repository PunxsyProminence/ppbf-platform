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
  ...jest.requireActual('@/src/server/pilot/parentPassword'),
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
const HASH_KEY = 'password_set_hash_account:parent-1';
/** Stands in for the scrypt: called by the fake set-password only when the route's beforeHash let it through. */
const hashRan = jest.fn();

/** What the real function does around the hash: the route's hook, then the hash. */
async function hashingSetPassword(input: { beforeHash: () => Promise<void> }): Promise<void> {
  await input.beforeHash();
  // The real hash takes time; requests arriving together overlap inside it.
  await new Promise((resolve) => setImmediate(resolve));
  hashRan();
}

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
  rateLimit.clearRateLimit(HASH_KEY);
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
      beforeHash: expect.any(Function),
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

  test.each(['coach', 'staff', 'volunteer', 'athlete', 'organization_admin', 'platform_owner', 'board'] as const)(
    'a %s session is refused at the route with the same answer, and is counted',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue({
        accountId: 'parent-1', role, organizationId: 'org-1', athleteId: null,
        sessionToken: 'session-token-value', authProvider: 'microsoft' as const,
      } as never);

      const res = await post({ password: GOOD_PASSWORD });

      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('PASSWORD_SETUP_LINK_REQUIRED');
      expect(mockSetPassword).not.toHaveBeenCalled();
      expect(rateLimit.recordDurableFailedAttempt).toHaveBeenCalledTimes(2);
    },
  );

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

  // The emailed-link session that permits a set stays good for fifteen
  // minutes and survives its own success. Every request that reaches the hash
  // is counted, and a success does not erase the count.
  describe('the hash allowance, per account, not cleared by success', () => {
    let now: number;
    let clock: jest.SpyInstance;

    beforeEach(() => {
      now = 1_800_000_000_000;
      clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
      mockSetPassword.mockImplementation(hashingSetPassword as never);
    });

    afterEach(() => {
      clock.mockRestore();
      rateLimit.clearRateLimit(HASH_KEY);
    });

    test('an ordinary one-time set succeeds, and the hash runs once', async () => {
      expect((await post({ password: GOOD_PASSWORD })).status).toBe(200);
      expect(hashRan).toHaveBeenCalledTimes(1);
    });

    test('a set, then a replace a few seconds later, both succeed', async () => {
      expect((await post({ password: GOOD_PASSWORD })).status).toBe(200);
      now += 3_000;
      expect((await post({ password: 'a different harbor' })).status).toBe(200);
      expect(hashRan).toHaveBeenCalledTimes(2);
    });

    test('a second set within a second of a successful one waits: 429, and the hash is not run', async () => {
      expect((await post({ password: GOOD_PASSWORD })).status).toBe(200);
      now += 500;

      const res = await post({ password: GOOD_PASSWORD });

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'Too many attempts. Please try again later.' });
      expect(hashRan).toHaveBeenCalledTimes(1);
      expect(writePilotAuditEvent).toHaveBeenCalledTimes(1);
    });

    test('repeated successful sets on one link session reach the bound, and the hash stops running', async () => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        statuses.push((await post({ password: GOOD_PASSWORD })).status);
        now += 1_500;
      }

      // Six go through a second and a half apart (the sixth starts the
      // doubling); after that the waits outgrow the spacing.
      expect(statuses.slice(0, 6)).toEqual([200, 200, 200, 200, 200, 200]);
      expect(statuses.slice(6)).toContain(429);
      expect(statuses.filter((status) => status === 200).length).toBeLessThan(12);
      // The hash ran exactly as many times as a request was let through.
      expect(hashRan).toHaveBeenCalledTimes(statuses.filter((status) => status === 200).length);
    });

    test('at most about two dozen hashes in fifteen minutes, however hard one link is driven', async () => {
      // One request every 100 ms for the fifteen minutes a link session is proof.
      for (let elapsed = 0; elapsed < 15 * 60 * 1000; elapsed += 100) {
        await post({ password: GOOD_PASSWORD });
        now += 100;
      }

      expect(hashRan.mock.calls.length).toBeGreaterThanOrEqual(5);
      expect(hashRan.mock.calls.length).toBeLessThanOrEqual(25);
    });

    test('success does not clear the hash allowance; it clears only the refusal buckets', async () => {
      await post({ password: GOOD_PASSWORD });

      expect(rateLimit.clearDurableRateLimit.mock.calls.map(([key]) => key)).toEqual([
        'password_set_account:parent-1',
        'password_set_ip:203.0.113.9',
      ]);
      expect(rateLimit.recordDurableFailedAttempt.mock.calls.map(([key]) => key)).toEqual([HASH_KEY]);
    });

    test('it is per account: another account behind the same address is not slowed by this one', async () => {
      expect((await post({ password: GOOD_PASSWORD })).status).toBe(200);
      mockRequirePrincipal.mockResolvedValue({
        accountId: 'parent-2', role: 'parent' as const, organizationId: 'org-1', athleteId: null,
        sessionToken: 'another-session', authProvider: 'microsoft' as const,
      } as never);

      expect((await post({ password: GOOD_PASSWORD })).status).toBe(200);
      expect(hashRan).toHaveBeenCalledTimes(2);
      rateLimit.clearRateLimit('password_set_hash_account:parent-2');
      rateLimit.clearRateLimit('password_set_account:parent-2');
    });

    // A burst, not a sequence: the requests are all in flight before any of
    // them has finished. One hash, and everyone else waits.
    test('twenty requests arriving together run the hash once', async () => {
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => post({ password: GOOD_PASSWORD })),
      );

      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      expect(statuses.filter((status) => status === 429)).toHaveLength(19);
      expect(hashRan).toHaveBeenCalledTimes(1);
    });

    // The hook ran (the allowance is spent) and the request was then refused
    // inside the transaction. The refusal is counted as one; the hash
    // allowance is not handed back.
    test('a request refused after the hash keeps its hash counted', async () => {
      mockSetPassword.mockImplementationOnce((async (input: { beforeHash: () => Promise<void> }) => {
        await input.beforeHash();
        hashRan();
        throw linkRequired();
      }) as never);

      expect((await post({ password: GOOD_PASSWORD })).status).toBe(403);

      expect(rateLimit.recordDurableFailedAttempt.mock.calls.map(([key]) => key)).toEqual([
        HASH_KEY,
        'password_set_account:parent-1',
        'password_set_ip:203.0.113.9',
      ]);
      expect(rateLimit.clearDurableRateLimit).not.toHaveBeenCalled();
      rateLimit.clearRateLimit('password_set_account:parent-1');
      rateLimit.clearRateLimit('password_set_ip:203.0.113.9');
      now += 500;
      // Still inside the 1-second pause that hash earned.
      expect((await post({ password: GOOD_PASSWORD })).status).toBe(429);
      expect(hashRan).toHaveBeenCalledTimes(1);
    });

    // The count is written before the hash starts, not alongside it: with the
    // durable store on, the hash must not be running while its own count is
    // still on its way to the database.
    test('the hash does not start until its count has been recorded', async () => {
      let finishRecording!: () => void;
      rateLimit.recordDurableFailedAttempt.mockImplementationOnce(async (key: string) => {
        const recorded = actualRateLimit.recordFailedAttempt(key);
        await new Promise<void>((resolve) => { finishRecording = resolve; });
        return recorded;
      });

      const pending = post({ password: GOOD_PASSWORD });
      for (let tick = 0; tick < 20; tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(hashRan).not.toHaveBeenCalled();

      finishRecording();
      expect((await pending).status).toBe(200);
      expect(hashRan).toHaveBeenCalledTimes(1);
    });

    test('a durable hash limit is honoured: 429 and no hash', async () => {
      rateLimit.checkDurableRateLimit.mockImplementation(async (key: string) => (
        key === HASH_KEY ? { isLimited: true, delayMs: 30_000 } : { isLimited: false }
      ));

      expect((await post({ password: GOOD_PASSWORD })).status).toBe(429);
      expect(hashRan).not.toHaveBeenCalled();
    });

    test('a request that never reaches the hash does not spend the allowance', async () => {
      // A weak password and a missing proof are both decided before the hook.
      mockSetPassword.mockImplementationOnce(async ({ password }) => validatePasswordPolicy(password));
      expect((await post({ password: 'password123' })).status).toBe(400);
      mockSetPassword.mockRejectedValueOnce(linkRequired());
      expect((await post({ password: GOOD_PASSWORD })).status).toBe(403);

      expect(rateLimit.recordDurableFailedAttempt.mock.calls.map(([key]) => key)).not.toContain(HASH_KEY);
      rateLimit.clearRateLimit('password_set_account:parent-1');
      rateLimit.clearRateLimit('password_set_ip:203.0.113.9');
      // And the next good request goes straight through.
      expect((await post({ password: GOOD_PASSWORD })).status).toBe(200);
      expect(hashRan).toHaveBeenCalledTimes(1);
    });

    test('being made to wait for the hash is not counted as a refusal', async () => {
      await post({ password: GOOD_PASSWORD });
      rateLimit.recordDurableFailedAttempt.mockClear();
      now += 200;

      expect((await post({ password: GOOD_PASSWORD })).status).toBe(429);
      expect(rateLimit.recordDurableFailedAttempt).not.toHaveBeenCalled();
    });
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
