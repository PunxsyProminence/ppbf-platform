import { NextRequest } from 'next/server';

import { POST } from './route';
import { loginWithAccountIdAndPin } from '@/src/server/pilot/auth';
import { withPoolClient } from '@/src/server/pilot/db';

// Audit follow-up on task #47's coverage. route.test.ts mocks
// '@/src/server/pilot/rateLimit' wholesale, so the test that used to live
// there named "a durable store outage does not lock anyone out" could only
// ever assert on a hand-picked mock return value -- it never made the
// durable store actually fail, so it never exercised the fallback it claimed
// to verify (see the comment left in route.test.ts).
//
// This file leaves rateLimit.ts UNMOCKED and instead fails the layer it
// itself depends on: the Postgres pool client from '@/src/server/pilot/db'.
// That drives the request through the real checkDurableRateLimit /
// withDurableClient fallback documented in rateLimit.ts:
//
//   "if the durable store cannot be reached, the honest fallback is the
//   in-memory limiter, NOT locking every athlete out of the platform."
//
// If that fallback ever regresses -- the catch block removed, or changed to
// rethrow -- withPoolClient's rejection propagates out of checkDurableRateLimit,
// past route.ts's outer try/catch (which has no dedicated handling for it),
// and this test fails with a 500 instead of the expected 200.
jest.mock('@/src/server/pilot/auth', () => ({
  loginWithAccountIdAndPin: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/db', () => ({
  withPoolClient: jest.fn(),
}));

const mockLogin = loginWithAccountIdAndPin as jest.Mock;
const mockWithPoolClient = withPoolClient as jest.Mock;

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  // Durable rate limiting only runs the pool-client path at all when both of
  // these are set (see durableRateLimitEnabled() in rateLimit.ts). Without
  // this, withDurableClient short-circuits to null before ever touching
  // withPoolClient, and the test would pass for the wrong reason -- durable
  // rate limiting being off, not the outage fallback working.
  process.env = {
    ...ORIGINAL_ENV,
    PPBF_DURABLE_RATE_LIMIT: 'true',
    AZURE_POSTGRES_CONNECTION_STRING: 'postgresql://outage-test:not-a-real-connection@localhost/pilot',
  };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
  jest.clearAllMocks();
});

function request(accountId: string) {
  return new NextRequest('http://localhost/api/pilot/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account_id: accountId, pin: '123456' }),
  });
}

describe('POST /api/pilot/auth/login durable store outage (real fallback, not a mocked return value)', () => {
  test('a durable store outage does not lock anyone out', async () => {
    // The pool client rejects on every acquisition attempt -- the shape of a
    // real Postgres outage (connection refused, DNS failure, exhausted pool),
    // not a query-level error.
    mockWithPoolClient.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    mockLogin.mockResolvedValueOnce({
      token: 'tok-outage',
      principal: {
        accountId: 'acct-outage-real',
        role: 'athlete',
        organizationId: 'org-1',
        athleteId: 'ath-1',
        sessionToken: 'tok-outage',
        authProvider: 'ppbf_local',
      },
    });

    const res = await POST(request('acct-outage-real'));

    expect(res.status).toBe(200);
    expect(res.cookies.get('ppbf_pilot_session')?.value).toBe('tok-outage');

    // Proves the durable path was actually engaged and actually failed --
    // without this, the test could pass merely because durable rate
    // limiting was silently disabled rather than because the fallback held
    // up against a real failure.
    expect(mockWithPoolClient).toHaveBeenCalled();
  });

  test('a durable store outage does not block a failed login either', async () => {
    // Same failure, but on the invalid-credentials path, which calls
    // recordDurableFailedAttempt (also routed through withDurableClient).
    // It must fall back to the in-memory delay rather than throwing.
    mockWithPoolClient.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));
    mockLogin.mockResolvedValueOnce(null);

    const res = await POST(request('acct-outage-invalid'));

    expect(res.status).toBe(401);
    expect(mockWithPoolClient).toHaveBeenCalled();
  });
});
