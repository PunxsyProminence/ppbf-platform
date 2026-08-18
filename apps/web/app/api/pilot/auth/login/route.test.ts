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
    // All three durable helpers are reset here, not just the check: the
    // outage tests below install rejections, and jest.clearAllMocks() clears
    // recorded calls WITHOUT clearing implementations, so a leftover
    // mockRejectedValue would otherwise leak into the next test.
    //
    // mockLogin is reset for the same reason, one queue further along. A test
    // whose request is rejected before it reaches loginWithAccountIdAndPin
    // leaves its unconsumed mockResolvedValueOnce sitting in the queue, and
    // clearAllMocks does not drain that either -- so the NEXT test silently
    // receives the previous test's principal. That shifted the results of
    // these outage tests by one and has to stay fixed.
    mockLogin.mockReset();
    mockCheckDurable.mockResolvedValue({ isLimited: false });
    mockRecordDurable.mockResolvedValue({ delayMs: 1000 });
    mockClearDurable.mockResolvedValue(undefined);
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

  // The property that matters most -- and the one this test previously only
  // claimed to cover. It re-stated the beforeEach default of
  // { isLimited: false }, so it was the happy path wearing an outage's name
  // and never simulated an unreachable store at all.
  //
  // A rate-limit lookup is a guard, not the operation. If the durable store
  // cannot be reached the route must degrade to the volatile limiter, never
  // deny: failing this closed locks every athlete out at once, along with
  // every coach reaching safety records, on a single database blip -- a far
  // worse outage than the brute force it guards against.
  //
  // rateLimit.ts's withDurableClient is written to swallow its own errors and
  // report not-limited, so today a rejection should not escape it. That is
  // precisely why the route is pinned independently here: this route's
  // fail-open promise must not rest on an invariant held one module away,
  // where a refactor can quietly drop it and nothing on the login path
  // would notice.
  const outage = () => new Error('connect ECONNREFUSED 10.0.0.4:5432');

  test('a durable store outage on the pre-auth check does not lock anyone out', async () => {
    mockCheckRateLimit.mockReturnValue({ isLimited: false });
    mockCheckDurable.mockRejectedValue(outage());
    mockLogin.mockResolvedValueOnce({
      token: 'tok',
      principal: {
        accountId: 'acct-outage',
        role: 'athlete',
        organizationId: 'org-1',
        athleteId: 'ath-1',
        sessionToken: 'tok',
        authProvider: 'ppbf_local',
      },
    });

    const res = await POST(request('acct-outage'));

    expect(res.status).toBe(200);
    expect(res.cookies.get('ppbf_pilot_session')?.value).toBe('tok');
    expect(mockLogin).toHaveBeenCalled();
  });

  // Failing open on the DURABLE store must not switch rate limiting off
  // altogether. Without this, the cure for the lockout above would hand an
  // attacker an unlimited 6-digit PIN budget the moment the database became
  // unreachable. The volatile limiter is the documented fallback, so it has
  // to still bite while the durable half is down.
  test('a durable store outage still leaves the volatile limiter in force', async () => {
    mockCheckDurable.mockRejectedValue(outage());
    mockCheckRateLimit.mockReturnValue({ isLimited: true, delayMs: 30_000 });

    const res = await POST(request('acct-outage-limited'));

    expect(res.status).toBe(429);
    expect(mockLogin).not.toHaveBeenCalled();
  });

  // The success path. clearDurableRateLimit runs AFTER the PIN was accepted
  // and a session token was minted, but BEFORE the cookie is attached -- so
  // an unreachable store there returns a 500 to someone who has already
  // authenticated, and issues them no session. Identical in shape to the
  // audit-write failure guarded above: clearing a bucket is bookkeeping, not
  // the operation, and must not be able to revoke a login that succeeded.
  test('a durable store outage while clearing counters still issues the session', async () => {
    mockCheckRateLimit.mockReturnValue({ isLimited: false });
    mockClearDurable.mockRejectedValue(outage());
    mockLogin.mockResolvedValueOnce({
      token: 'tok-clear',
      principal: {
        accountId: 'acct-outage-clear',
        role: 'coach',
        organizationId: 'org-1',
        athleteId: null,
        sessionToken: 'tok-clear',
        authProvider: 'ppbf_local',
      },
    });

    const res = await POST(request('acct-outage-clear'));

    expect(res.status).toBe(200);
    expect(res.cookies.get('ppbf_pilot_session')?.value).toBe('tok-clear');
  });

  // The failure path. A wrong PIN during an outage must still read as a wrong
  // PIN. If the durable write escapes, the 401 becomes a 500 that tells an
  // athlete the server is broken when in fact they mistyped, and tells an
  // attacker that the rate limiter is down.
  test('a durable store outage while recording a failure still returns 401', async () => {
    mockCheckRateLimit.mockReturnValue({ isLimited: false });
    mockRecordDurable.mockRejectedValue(outage());
    mockLogin.mockResolvedValueOnce(null);

    const res = await POST(request('acct-outage-bad-pin'));

    expect(res.status).toBe(401);
    expect(res.cookies.get('ppbf_pilot_session')).toBeUndefined();
  });

  test('the volatile limiter still blocks on its own', async () => {
    // Belt and braces: durable clear, volatile limited.
    mockCheckDurable.mockResolvedValue({ isLimited: false });
    mockCheckRateLimit.mockReturnValueOnce({ isLimited: true, delayMs: 2_000 });

    const res = await POST(request('acct-volatile'));

    expect(res.status).toBe(429);
    expect(mockLogin).not.toHaveBeenCalled();
  });
});
