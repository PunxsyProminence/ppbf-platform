import { NextRequest } from 'next/server';

import { createFakeDurableRateLimitStore, enableDurable, loadReplica } from '@/src/testing/fakeDurableRateLimitStore';

// CL-A4 follow-up: the IP bucket here was recorded only after an await, so a
// burst across many addresses from one IP -- the roster walk the IP axis
// exists to slow -- all passed the IP read. rateLimit.ts is left real; the
// durable half runs on a shared fake store only in the replica test.
const mockDurableStore = createFakeDurableRateLimitStore();
const mockIssue = jest.fn();

jest.mock('@/src/server/pilot/db', () => ({
  ...jest.requireActual('@/src/server/pilot/db'),
  withPoolClient: (work: never) => mockDurableStore.withPoolClient(work),
}));

jest.mock('@/src/server/pilot/magicLink', () => ({
  issueMagicLink: (...args: unknown[]) => mockIssue(...args),
}));

jest.mock('@/src/server/pilot/magicLinkStore', () => ({
  magicLinkDependencies: () => ({}),
}));

type Route = typeof import('./route');

function post(route: Route, ip: string, email: string) {
  return route.POST(new NextRequest('http://localhost/api/pilot/auth/magic-link/request', {
    method: 'POST',
    body: JSON.stringify({ email }),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  }));
}

const freshRoute = () => loadReplica<Route>(() => jest.requireActual<Route>('./route'));

beforeEach(() => {
  mockDurableStore.buckets.clear();
  mockIssue.mockReset().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 20)));
});

describe('POST /api/pilot/auth/magic-link/request under a burst', () => {
  test('20 different addresses from one IP sent together: one link is issued', async () => {
    const route = freshRoute();

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post(route, '10.4.0.1', `walk-${i}@example.com`)),
    );

    expect(mockIssue).toHaveBeenCalledTimes(1);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(19);
  });

  test('one address from 20 IPs sent together: one link is issued', async () => {
    const route = freshRoute();

    await Promise.all(Array.from({ length: 20 }, (_, i) => post(route, `10.4.1.${i + 1}`, 'flood@example.com')));

    expect(mockIssue).toHaveBeenCalledTimes(1);
  });

  test('split across two replicas sharing the durable store, still one', async () => {
    const restore = enableDurable();
    try {
      const replicas = [freshRoute(), freshRoute()];

      await Promise.all(
        Array.from({ length: 20 }, (_, i) => post(replicas[i % 2], '10.4.2.1', `walk-${i}@example.com`)),
      );

      expect(mockIssue).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});
