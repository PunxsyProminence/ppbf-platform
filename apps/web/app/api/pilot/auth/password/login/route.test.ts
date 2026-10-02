/**
 * @jest-environment node
 */
import { NextRequest } from 'next/server';

import { POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { loginWithEmailAndPassword } from '@/src/server/pilot/parentPasswordSignIn';

/*
  What the ROUTE adds to parentPasswordSignIn.ts: the attempt limit, the one
  answer every refusal gets, the audit row and the cookie. Who is admitted is
  proven against real Postgres in parentPasswordSignIn.pg.test.ts.
*/

jest.mock('@/src/server/pilot/parentPasswordSignIn', () => ({
  ...jest.requireActual('@/src/server/pilot/parentPasswordSignIn'),
  loginWithEmailAndPassword: jest.fn(),
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

const mockLogin = jest.mocked(loginWithEmailAndPassword);
const rateLimit = jest.requireMock('@/src/server/pilot/rateLimit') as {
  checkDurableRateLimit: jest.Mock;
  recordDurableFailedAttempt: jest.Mock;
  clearDurableRateLimit: jest.Mock;
  clearRateLimit: (key: string) => void;
  recordFailedAttempt: (key: string) => unknown;
};
const actualRateLimit = jest.requireActual('@/src/server/pilot/rateLimit') as typeof import('@/src/server/pilot/rateLimit');

const EMAIL = 'parent@example.com';
const PASSWORD = 'three small boats';
const EMAIL_KEY = `password_login_email:${EMAIL}`;
const IP_KEY = 'password_login_ip:203.0.113.9';
const SESSION_TOKEN = 'opaque-session-token-value';
/** Stands in for the scrypt: called by the fake sign-in each time the route lets a request through. */
const verifyRan = jest.fn();

const ADMITTED = {
  token: SESSION_TOKEN,
  principal: {
    accountId: EMAIL,
    role: 'parent' as const,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: SESSION_TOKEN,
    authProvider: 'microsoft' as const,
  },
};

function post(body: unknown) {
  return POST(new NextRequest('http://localhost/api/pilot/auth/password/login', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }));
}

let now: number;
let clock: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  now = 1_800_000_000_000;
  clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  rateLimit.clearRateLimit(EMAIL_KEY);
  rateLimit.clearRateLimit(IP_KEY);
  mockLogin.mockImplementation(async () => {
    // The real verification takes time; requests arriving together overlap inside it.
    await new Promise((resolve) => setImmediate(resolve));
    verifyRan();
    return ADMITTED as never;
  });
  // clearAllMocks keeps implementations; put the real ones back.
  rateLimit.checkDurableRateLimit.mockImplementation(actualRateLimit.checkDurableRateLimit);
  rateLimit.recordDurableFailedAttempt.mockImplementation(actualRateLimit.recordDurableFailedAttempt);
});

afterEach(() => {
  clock.mockRestore();
});

function refuseEveryone() {
  mockLogin.mockImplementation(async () => {
    await new Promise((resolve) => setImmediate(resolve));
    verifyRan();
    return null;
  });
}

describe('POST /api/pilot/auth/password/login', () => {
  test('a parent is signed in: the cookie carries the session, the body says who', async () => {
    const res = await post({ email: EMAIL, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      account_id: EMAIL,
      role: 'parent',
      organization_id: 'org-1',
    });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(SESSION_TOKEN);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//);
  });

  test('the email is trimmed and lower-cased; the password is passed exactly as typed', async () => {
    await post({ email: '  Parent@Example.COM ', password: `  ${PASSWORD} ` });

    expect(mockLogin).toHaveBeenCalledWith(EMAIL, `  ${PASSWORD} `);
  });

  test('success writes a login audit row that names the door and carries no password', async () => {
    await post({ email: EMAIL, password: PASSWORD });

    expect(writePilotAuditEvent).toHaveBeenCalledWith({
      event_type: 'login',
      actor_account_id: EMAIL,
      actor_role: 'parent',
      organization_id: 'org-1',
      entity_type: 'account',
      entity_id: EMAIL,
      details: { auth_provider: 'password' },
    });
    expect(JSON.stringify(jest.mocked(writePilotAuditEvent).mock.calls)).not.toContain(PASSWORD);
  });

  test('a lost audit row does not turn a correct sign-in into an error', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.mocked(writePilotAuditEvent).mockRejectedValueOnce(new Error('audit down'));

    const res = await post({ email: EMAIL, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain(SESSION_TOKEN);
    error.mockRestore();
  });

  test('a refusal is one 401 with one body, no cookie and no audit row', async () => {
    refuseEveryone();

    const res = await post({ email: EMAIL, password: 'not the password' });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid credentials' });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(writePilotAuditEvent).not.toHaveBeenCalled();
  });

  test.each([
    ['a missing email', { password: PASSWORD }],
    ['a missing password', { email: EMAIL }],
    ['an email that is only spaces', { email: '   ', password: PASSWORD }],
    ['a password that is not a string', { email: EMAIL, password: 1234567890 }],
    ['an email that is not a string', { email: ['a@b.c'], password: PASSWORD }],
    ['a body that is not JSON', 'not json'],
    ['a body that is the JSON value null', 'null'],
    ['a body that is a JSON array', '[]'],
  ])('%s is a 400 and nothing is looked up or counted', async (_label, body) => {
    const res = await post(body);

    expect(res.status).toBe(400);
    expect(mockLogin).not.toHaveBeenCalled();
    expect(rateLimit.recordDurableFailedAttempt).not.toHaveBeenCalled();
  });

  test('a password of only spaces is a password: it is not trimmed away into a 400', async () => {
    refuseEveryone();

    const res = await post({ email: EMAIL, password: '          ' });

    expect(res.status).toBe(401);
    expect(mockLogin).toHaveBeenCalledWith(EMAIL, '          ');
  });

  test('an address too long to be one is refused like a wrong password, counted against the IP only', async () => {
    const res = await post({ email: `${'a'.repeat(300)}@example.com`, password: PASSWORD });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid credentials' });
    expect(mockLogin).not.toHaveBeenCalled();
    expect(rateLimit.recordDurableFailedAttempt.mock.calls.map(([key]) => key)).toEqual([IP_KEY]);
  });

  test('and it is held to the IP bucket like any other attempt: the second one waits, and is not counted', async () => {
    const tooLong = { email: `${'a'.repeat(300)}@example.com`, password: PASSWORD };
    expect((await post(tooLong)).status).toBe(401);
    rateLimit.recordDurableFailedAttempt.mockClear();
    now += 200;

    const res = await post(tooLong);

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many sign-in attempts. Please wait a few minutes.' });
    expect(rateLimit.recordDurableFailedAttempt).not.toHaveBeenCalled();

    // The durable bucket alone is enough, as it is for an ordinary attempt.
    rateLimit.clearRateLimit(IP_KEY);
    rateLimit.checkDurableRateLimit.mockImplementation(async (key: string) => (
      key === IP_KEY ? { isLimited: true, delayMs: 30_000 } : { isLimited: false }
    ));
    expect((await post(tooLong)).status).toBe(429);
    expect(rateLimit.recordDurableFailedAttempt).not.toHaveBeenCalled();
  });

  describe('the attempt limit', () => {
    test('every attempt is counted on both buckets BEFORE the password is verified', async () => {
      const order: string[] = [];
      rateLimit.recordDurableFailedAttempt.mockImplementation(async (key: string) => {
        order.push(`count:${key}`);
        return actualRateLimit.recordDurableFailedAttempt(key);
      });
      mockLogin.mockImplementation(async () => {
        order.push('verify');
        return ADMITTED as never;
      });

      await post({ email: EMAIL, password: PASSWORD });

      expect(order).toEqual([`count:${EMAIL_KEY}`, `count:${IP_KEY}`, 'verify']);
    });

    test('the verification does not start until both counts have been recorded', async () => {
      const finish: Array<() => void> = [];
      rateLimit.recordDurableFailedAttempt.mockImplementation(async (key: string) => {
        const recorded = actualRateLimit.recordFailedAttempt(key);
        await new Promise<void>((resolve) => { finish.push(resolve); });
        return recorded;
      });

      const pending = post({ email: EMAIL, password: PASSWORD });
      for (let tick = 0; tick < 20; tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(finish).toHaveLength(2);
      expect(mockLogin).not.toHaveBeenCalled();

      finish[0]();
      for (let tick = 0; tick < 20; tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(mockLogin).not.toHaveBeenCalled();

      finish[1]();
      expect((await pending).status).toBe(200);
    });

    // A burst, not a sequence: all in flight before any has finished. One
    // reaches the verification; the rest are made to wait.
    test('twenty wrong guesses at one email arriving together run the verification once', async () => {
      refuseEveryone();

      const responses = await Promise.all(
        Array.from({ length: 20 }, () => post({ email: EMAIL, password: 'a wrong guess' })),
      );

      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === 401)).toHaveLength(1);
      expect(statuses.filter((status) => status === 429)).toHaveLength(19);
      expect(verifyRan).toHaveBeenCalledTimes(1);
    });

    test('twenty guesses at twenty different emails from one address arriving together run it once', async () => {
      refuseEveryone();

      const responses = await Promise.all(
        Array.from({ length: 20 }, (_unused, index) => post({ email: `guess-${index}@example.com`, password: 'a wrong guess' })),
      );

      expect(responses.filter((response) => response.status === 401)).toHaveLength(1);
      expect(verifyRan).toHaveBeenCalledTimes(1);
      for (let index = 0; index < 20; index += 1) {
        rateLimit.clearRateLimit(`password_login_email:guess-${index}@example.com`);
      }
    });

    test('being made to wait is one 429 body whichever bucket is full, and is not counted again', async () => {
      refuseEveryone();
      await post({ email: EMAIL, password: 'a wrong guess' });
      rateLimit.recordDurableFailedAttempt.mockClear();
      now += 200;

      const res = await post({ email: EMAIL, password: 'a wrong guess' });

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'Too many sign-in attempts. Please wait a few minutes.' });
      expect(rateLimit.recordDurableFailedAttempt).not.toHaveBeenCalled();
      expect(verifyRan).toHaveBeenCalledTimes(1);
    });

    // Each of the four checks, limited alone while the other three are clear.
    test.each([
      ['the durable email bucket', 'durable', EMAIL_KEY],
      ['the durable IP bucket', 'durable', IP_KEY],
      ['the in-memory email bucket', 'volatile', EMAIL_KEY],
      ['the in-memory IP bucket', 'volatile', IP_KEY],
    ])('%s alone is enough for a 429, with the same body, before the password is verified', async (_label, store, limitedKey) => {
      if (store === 'durable') {
        rateLimit.checkDurableRateLimit.mockImplementation(async (key: string) => (
          key === limitedKey ? { isLimited: true, delayMs: 30_000 } : { isLimited: false }
        ));
      } else {
        rateLimit.recordFailedAttempt(limitedKey);
      }

      const res = await post({ email: EMAIL, password: PASSWORD });

      expect(res.status).toBe(429);
      expect(await res.json()).toEqual({ error: 'Too many sign-in attempts. Please wait a few minutes.' });
      expect(mockLogin).not.toHaveBeenCalled();
    });

    test('a slow-down, not a lockout: wrong guesses wait longer each time, and a later attempt is let through', async () => {
      refuseEveryone();

      // Hammered every 100 ms for five minutes.
      for (let elapsed = 0; elapsed < 5 * 60 * 1000; elapsed += 100) {
        await post({ email: EMAIL, password: 'a wrong guess' });
        now += 100;
      }
      // Five at a second apart, then doubling to a minute: about a dozen.
      expect(verifyRan.mock.calls.length).toBeGreaterThanOrEqual(5);
      expect(verifyRan.mock.calls.length).toBeLessThanOrEqual(15);

      // The longest wait is a minute. After it, the right password signs in.
      now += 61_000;
      mockLogin.mockResolvedValue(ADMITTED as never);
      expect((await post({ email: EMAIL, password: PASSWORD })).status).toBe(200);
    });

    test('a success clears both buckets, so the next parent on the same address is not made to wait', async () => {
      expect((await post({ email: EMAIL, password: PASSWORD })).status).toBe(200);

      expect(rateLimit.clearDurableRateLimit.mock.calls.map(([key]) => key)).toEqual([EMAIL_KEY, IP_KEY]);
      // Same instant, same address, another parent.
      expect((await post({ email: 'another-parent@example.com', password: PASSWORD })).status).toBe(200);
      rateLimit.clearRateLimit('password_login_email:another-parent@example.com');
    });

    test('twelve parents signing in correctly from one address inside a minute all get in', async () => {
      const statuses: number[] = [];
      for (let parent = 0; parent < 12; parent += 1) {
        statuses.push((await post({ email: `parent-${parent}@example.com`, password: PASSWORD })).status);
        now += 5_000;
      }

      expect(statuses).toEqual(Array(12).fill(200));
    });

    test('a refusal clears nothing', async () => {
      refuseEveryone();

      await post({ email: EMAIL, password: 'a wrong guess' });

      expect(rateLimit.clearDurableRateLimit).not.toHaveBeenCalled();
    });

    test('the wait is the same for an email with an account and one without: the bucket is the email as typed', async () => {
      refuseEveryone();

      await post({ email: 'nobody-by-this-name@example.com', password: 'a wrong guess' });
      now += 200;
      rateLimit.clearRateLimit(IP_KEY);
      const res = await post({ email: 'nobody-by-this-name@example.com', password: 'a wrong guess' });

      expect(res.status).toBe(429);
      rateLimit.clearRateLimit('password_login_email:nobody-by-this-name@example.com');
    });
  });

  test('nothing the route logs or returns carries the password', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    refuseEveryone();

    const refused = await post({ email: EMAIL, password: PASSWORD });
    now += 5_000;
    mockLogin.mockRejectedValueOnce(new Error('database unreachable'));
    const failed = await post({ email: EMAIL, password: PASSWORD });

    const said = JSON.stringify([
      warn.mock.calls, error.mock.calls, log.mock.calls, await refused.json(), await failed.json(),
    ]);
    expect(said).not.toContain(PASSWORD);
    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });

  test('an unexpected failure is a 500 that says nothing, and sets no cookie', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    mockLogin.mockRejectedValue(new Error('connection string postgres://secret'));

    const res = await post({ email: EMAIL, password: PASSWORD });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
    expect(res.headers.get('set-cookie')).toBeNull();
    error.mockRestore();
  });
});
