import { NextRequest } from 'next/server';

import { createFakeDurableRateLimitStore, enableDurable, loadReplica } from '@/src/testing/fakeDurableRateLimitStore';

// CL-A4 follow-up: both bootstrap routes read the shared pin_bootstrap:{ip}
// bucket, awaited the durable read, compared the key and only then recorded
// the failure, so a burst of key guesses all reached the compare. They share
// one bucket by design, so the burst here is split across both routes.
// rateLimit.ts is left real; the durable half runs on a shared fake store only
// in the replica test.
const mockDurableStore = createFakeDurableRateLimitStore();
const mockKeyMatches = jest.fn();

jest.mock('@/src/server/pilot/db', () => ({
  ...jest.requireActual('@/src/server/pilot/db'),
  withPoolClient: (work: never) => mockDurableStore.withPoolClient(work),
}));

jest.mock('@/src/server/pilot/security', () => ({
  ...jest.requireActual('@/src/server/pilot/security'),
  bootstrapKeyMatches: (...args: unknown[]) => mockKeyMatches(...args),
}));

type Route = { POST: (request: NextRequest) => Promise<Response> };

function post(route: Route, ip: string) {
  return route.POST(new NextRequest('http://localhost/api/pilot/admin/bootstrap', {
    method: 'POST',
    body: '{}',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, 'x-ppbf-bootstrap-key': 'a guess' },
  }));
}

/** One replica: both bootstrap routes, loaded together so they share that replica's in-memory limiter. */
function freshReplica(): Route[] {
  return loadReplica(() => [
    jest.requireActual<Route>('./route'),
    jest.requireActual<Route>('./platform-owner-microsoft/route'),
  ]);
}

const originalKey = process.env.PPBF_PILOT_BOOTSTRAP_KEY;
beforeEach(() => {
  process.env.PPBF_PILOT_BOOTSTRAP_KEY = 'the-real-key';
  mockDurableStore.buckets.clear();
  mockKeyMatches.mockReset().mockReturnValue(false);
});
afterEach(() => {
  if (originalKey === undefined) {
    delete process.env.PPBF_PILOT_BOOTSTRAP_KEY;
  } else {
    process.env.PPBF_PILOT_BOOTSTRAP_KEY = originalKey;
  }
});

describe('the bootstrap routes under a burst of key guesses', () => {
  test('of 20 guesses from one IP across both routes sent together, one reaches the key compare', async () => {
    const routes = freshReplica();

    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => post(routes[i % 2], '10.6.0.1')));

    expect(mockKeyMatches).toHaveBeenCalledTimes(1);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(19);
  });

  test('split across two replicas sharing the durable store, still one', async () => {
    const restore = enableDurable();
    try {
      const replicas = [freshReplica(), freshReplica()];

      await Promise.all(
        Array.from({ length: 20 }, (_, i) => post(replicas[i % 2][Math.floor(i / 2) % 2], '10.6.1.1')),
      );

      expect(mockKeyMatches).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});
