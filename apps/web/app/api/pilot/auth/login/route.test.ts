import { NextRequest } from 'next/server';

import { POST } from './route';
import { loginWithAccountIdAndPin } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { SESSION_ABSOLUTE_LIFETIME_SECONDS } from '@/src/server/pilot/sessionPolicy';
import {
  checkRateLimit,
  checkDurableRateLimit,
  recordFailedAttempt,
  recordDurableFailedAttempt,
  clearRateLimit,
  clearDurableRateLimit,
} from '@/src/server/pilot/rateLimit';

jest.mock('@/src/server/pilot/auth', () => ({
  loginWithAccountIdAndPin: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/rateLimit', () => ({
  getClientIp: jest.fn(() => '127.0.0.1'),
  checkRateLimit: jest.fn(() => ({ isLimited: false })),
  recordFailedAttempt: jest.fn(),
  clearRateLimit: jest.fn(),
  // The durable half. recordDurableFailedAttempt and clearDurableRateLimit
  // write the volatile entry too, so the route calls only those two on the
  // failure and success paths -- the volatile spies below assert through them.
  checkDurableRateLimit: jest.fn(async () => ({ isLimited: false })),
  recordDurableFailedAttempt: jest.fn(async () => ({ delayMs: 1000 })),
  clearDurableRateLimit: jest.fn(async () => undefined),
}));

const mockLogin = loginWithAccountIdAndPin as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;
const mockCheckRateLimit = checkRateLimit as jest.Mock;
const mockRecordFailedAttempt = recordFailedAttempt as jest.Mock;
const mockClearRateLimit = clearRateLimit as jest.Mock;
const mockCheckDurable = checkDurableRateLimit as jest.Mock;
const mockRecordDurable = recordDurableFailedAttempt as jest.Mock;
const mockClearDurable = clearDurableRateLimit as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function request(accountId: string) {
  return new NextRequest('http://localhost/api/pilot/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account_id: accountId, pin: '123456' }),
  });
}

describe('POST /api/pilot/auth/login', () => {
  test('the session cookie maxAge matches the centralized 24-hour session lifetime', async () => {
    mockLogin.mockResolvedValueOnce({
      token: 'a-token',
      principal: {
        accountId: 'acct-cookie-1',
        role: 'athlete',
        organizationId: 'org-1',
        athleteId: 'ath-1',
        sessionToken: 'a-token',
        authProvider: 'ppbf_local',
      },
    });

    const res = await POST(request('acct-cookie-1'));
    expect(res.status).toBe(200);

    const setCookie = res.cookies.get('ppbf_pilot_session');
    expect(setCookie?.value).toBe('a-token');
    expect(setCookie?.maxAge).toBe(SESSION_ABSOLUTE_LIFETIME_SECONDS);
    expect(SESSION_ABSOLUTE_LIFETIME_SECONDS).toBe(24 * 60 * 60);
  });

  // Previously a raw, unguarded writePilotAuditEvent call: a transient
  // audit-write failure threw past the cookie-setting code and returned a
  // 500 for an athlete who typed the correct PIN, with no session issued
  // despite the login itself having already succeeded.
  test('an audit-write failure does not turn a correct login into a 500', async () => {
    mockLogin.mockResolvedValueOnce({
      token: 'a-token',
      principal: {
        accountId: 'acct-audit-fail',
        role: 'athlete',
        organizationId: 'org-1',
        athleteId: 'ath-1',
        sessionToken: 'a-token',
        authProvider: 'ppbf_local',
      },
    });
    mockAudit.mockRejectedValueOnce(new Error('connection pool exhausted'));

    const res = await POST(request('acct-audit-fail'));

    expect(res.status).toBe(200);
    expect(res.cookies.get('ppbf_pilot_session')?.value).toBe('a-token');
  });

  test('401 for invalid credentials, no cookie set', async () => {
    mockLogin.mockResolvedValueOnce(null);
    const res = await POST(request('acct-cookie-2'));
    expect(res.status).toBe(401);
    expect(res.cookies.get('ppbf_pilot_session')).toBeUndefined();
    expect(mockRecordDurable).toHaveBeenCalledTimes(2);
  });

  test('returns 429 when account lockout is active', async () => {
    mockCheckRateLimit
      .mockReturnValueOnce({ isLimited: true, delayMs: 30000 })
      .mockReturnValueOnce({ isLimited: false });

    const res = await POST(request('acct-locked'));
    expect(res.status).toBe(429);
    expect(mockLogin).not.toHaveBeenCalled();
  });

  test('clears rate-limit counters after successful login', async () => {
    mockLogin.mockResolvedValueOnce({
      token: 'b-token',
      principal: {
        accountId: 'acct-cookie-3',
        role: 'athlete',
        organizationId: 'org-1',
        athleteId: 'ath-1',
        sessionToken: 'b-token',
        authProvider: 'ppbf_local',
      },
    });

    const res = await POST(request('acct-cookie-3'));
    expect(res.status).toBe(200);
    expect(mockClearDurable).toHaveBeenCalledTimes(2);
  });

  test('returns invalid credentials when auth service rejects privileged local PIN login', async () => {
    mockLogin.mockResolvedValueOnce(null);

    const res = await POST(request('coach-acct'));
    expect(res.status).toBe(401);
    expect(res.cookies.get('ppbf_pilot_session')).toBeUndefined();
    expect(mockRecordDurable).toHaveBeenCalledTimes(2);
  });
});

// Audit task #47. The volatile limiter was the ONLY brake on a 6-digit
// athlete PIN: per-process, so N replicas meant N independent attempt budgets
// against the same child's account, and every deploy reset every lockout.
// pilot.accounts has no failed-attempt column, so nothing else survived a
// restart. /auth/activate already used both limiters; login did not.
describe('POST /api/pilot/auth/login durable rate limiting', () => {
  beforeEach(() => {
    mockCheckDurable.mockResolvedValue({ isLimited: false });
  });

  test('a durable lockout blocks the attempt even when the in-memory store is empty', async () => {
    // The restart case: process memory is clean, the durable row is not.
    mockCheckRateLimit.mockReturnValue({ isLimited: false });
    mockCheckDurable.mockResolvedValueOnce({ isLimited: true, delayMs: 30_000 });

    const res = await POST(request('acct-durable-1'));

    expect(res.status).toBe(429);
    expect(mockLogin).not.toHaveBeenCalled();
  });

  test('an IP-scoped durable lockout blocks it too', async () => {
    mockCheckRateLimit.mockReturnValue({ isLimited: false });
    // First call is the account key, second is the IP key.
    mockCheckDurable
      .mockResolvedValueOnce({ isLimited: false })
      .mockResolvedValueOnce({ isLimited: true, delayMs: 5_000 });

    const res = await POST(request('acct-durable-2'));

    expect(res.status).toBe(429);
    expect(mockLogin).not.toHaveBeenCalled();
  });

  // The property that matters most -- a rate-limit lookup is a guard, not the
  // operation: if the durable store is unreachable it must degrade to the
  // volatile limiter, never deny -- used to be "verified" right here, but the
  // test only ever set mockCheckDurable to resolve { isLimited: false }: the
  // exact same value the beforeEach above already defaults it to. It never
  // simulated the durable store failing, so it was byte-for-byte the ordinary
  // successful-login path with an outage-flavored name and comment.
  //
  // Because @/src/server/pilot/rateLimit is mocked wholesale at the top of
  // this file, checkDurableRateLimit here IS the "durable store" as far as
  // route.ts is concerned -- there is no lower layer left in this module
  // registry to fail. Genuinely simulating the outage (the Postgres pool
  // rejecting) and proving the real withDurableClient/checkDurableRateLimit
  // fallback in rateLimit.ts degrades instead of throwing lives in
  // ./route.durableOutage.test.ts, which leaves rateLimit.ts unmocked and
  // fails the pool client itself.

  test('the volatile limiter still blocks on its own', async () => {
    // Belt and braces: durable clear, volatile limited.
    mockCheckDurable.mockResolvedValue({ isLimited: false });
    mockCheckRateLimit.mockReturnValueOnce({ isLimited: true, delayMs: 2_000 });

    const res = await POST(request('acct-volatile'));

    expect(res.status).toBe(429);
    expect(mockLogin).not.toHaveBeenCalled();
  });
});
