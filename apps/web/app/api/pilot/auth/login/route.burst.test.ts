import { NextRequest } from 'next/server';

import { POST } from './route';
import { loginWithAccountIdAndPin } from '@/src/server/pilot/auth';
import { clearRateLimit } from '@/src/server/pilot/rateLimit';

// CL-A4 (audit 2026-10-05): the PIN limiter was check-then-record. The route
// read the buckets, awaited the PIN check (scrypt), and counted a failure only
// afterwards, so every guess in a burst passed the "is limited" read before
// the first failure was written. This file leaves rateLimit.ts UNMOCKED (the
// durable half is off: no flag, no connection string) and fires the burst.
jest.mock('@/src/server/pilot/auth', () => ({
  loginWithAccountIdAndPin: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockLogin = loginWithAccountIdAndPin as jest.Mock;

function request(accountId: string, pin: string, ip: string) {
  return new NextRequest('http://localhost/api/pilot/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ account_id: accountId, pin }),
  });
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/pilot/auth/login under a burst of parallel guesses', () => {
  test('of 20 wrong PINs sent together, one reaches the PIN check and the rest are refused', async () => {
    const accountId = 'acct-burst-1';
    clearRateLimit(`pin_account:${accountId}`);
    // A slow wrong answer, the shape of scrypt: every request is in flight
    // before the first one learns it failed.
    mockLogin.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(null), 20)));

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => POST(request(accountId, String(100000 + i), `10.0.0.${i + 1}`))),
    );

    expect(mockLogin).toHaveBeenCalledTimes(1);
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(19);
  });

  // The gym's tablets share one public IP. Counting the IP bucket before the
  // PIN check would hold every other tablet off for the length of each
  // correct sign-in; it stays check-then-record (see route.ts).
  test('a class signing in together from one IP is not throttled', async () => {
    const ip = '10.9.9.9';
    clearRateLimit(`pin_ip:${ip}`);
    mockLogin.mockImplementation(
      (accountId: string) =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                token: `tok-${accountId}`,
                principal: { accountId, role: 'athlete', organizationId: 'org-1', athleteId: accountId },
              }),
            20,
          ),
        ),
    );

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) => POST(request(`acct-class-${i}`, '123456', ip))),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(12).fill(200));
  });
});
