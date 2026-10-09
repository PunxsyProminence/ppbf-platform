import { NextRequest } from 'next/server';

import { createFakeDurableRateLimitStore, enableDurable, loadReplica } from '@/src/testing/fakeDurableRateLimitStore';

// CL-A4 follow-up: activate read the IP bucket, awaited the redemption and
// recorded the failure afterwards, so a burst of code guesses all passed the
// read. rateLimit.ts is left real; the durable half runs on a shared fake
// store only in the replica test.
const mockDurableStore = createFakeDurableRateLimitStore();
const mockRedeem = jest.fn();

jest.mock('@/src/server/pilot/db', () => ({
  ...jest.requireActual('@/src/server/pilot/db'),
  withPoolClient: (work: never) => mockDurableStore.withPoolClient(work),
}));

jest.mock('@/src/server/pilot/activation', () => ({
  redeemActivationCode: (...args: unknown[]) => mockRedeem(...args),
}));

jest.mock('@/src/server/pilot/auth', () => ({
  loginWithAccountIdAndPin: jest.fn(async () => null),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(async () => undefined),
}));

type Route = typeof import('./route');

const PIN = '482917';

function post(route: Route, ip: string, code: string, pin = PIN) {
  return route.POST(new NextRequest('http://localhost/api/pilot/auth/activate', {
    method: 'POST',
    body: JSON.stringify({ code, pin }),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  }));
}

const freshRoute = () => loadReplica<Route>(() => jest.requireActual<Route>('./route'));

beforeEach(() => {
  mockDurableStore.buckets.clear();
  // A wrong code, answered after the PIN hash and the lookup.
  mockRedeem.mockReset().mockImplementation(
    () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Unauthorized: activation code invalid')), 20)),
  );
});

describe('POST /api/pilot/auth/activate under a burst of parallel code guesses', () => {
  test('of 20 guesses from one IP sent together, one reaches the redemption', async () => {
    const route = freshRoute();

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post(route, '10.3.0.1', `GUESS-${i}`)),
    );

    expect(mockRedeem).toHaveBeenCalledTimes(1);
    const limited = responses.filter((r) => r.status === 429);
    expect(limited).toHaveLength(19);
    expect(limited[0].headers.get('Retry-After')).toBe('1');
  });

  test('split across two replicas sharing the durable store, still one', async () => {
    const restore = enableDurable();
    try {
      const replicas = [freshRoute(), freshRoute()];

      await Promise.all(
        Array.from({ length: 20 }, (_, i) => post(replicas[i % 2], '10.3.1.1', `GUESS-${i}`)),
      );

      expect(mockRedeem).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  test('a PIN the rules refuse is a 400 and costs nothing: the next real attempt goes straight through', async () => {
    const route = freshRoute();

    for (const weak of ['111111', '123123', '112233', '12345']) {
      expect((await post(route, '10.3.2.1', 'ABCD-EFGH', weak)).status).toBe(400);
    }
    expect(mockRedeem).not.toHaveBeenCalled();

    expect((await post(route, '10.3.2.1', 'ABCD-EFGH')).status).not.toBe(429);
    expect(mockRedeem).toHaveBeenCalledTimes(1);
  });
});
