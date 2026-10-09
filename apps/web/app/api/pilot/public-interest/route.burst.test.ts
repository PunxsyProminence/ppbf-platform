import { NextRequest } from 'next/server';

import { createFakeDurableRateLimitStore, enableDurable, loadReplica } from '@/src/testing/fakeDurableRateLimitStore';

// CL-A4 follow-up: this route read the IP bucket, awaited the durable read,
// and only then counted the submission, so a burst all passed the read.
// rateLimit.ts is left real; the durable half runs on a shared fake store only
// in the replica test. The honeypot body is used because it is answered as
// soon as the limiter lets it through: a 200 is "admitted".
const mockDurableStore = createFakeDurableRateLimitStore();

jest.mock('@/src/server/pilot/db', () => ({
  ...jest.requireActual('@/src/server/pilot/db'),
  withPoolClient: (work: never) => mockDurableStore.withPoolClient(work),
}));

jest.mock('@/src/server/pilot/publicInterest', () => ({
  ...jest.requireActual('@/src/server/pilot/publicInterest'),
  createPublicInterestSubmission: jest.fn(),
}));

type Route = typeof import('./route');

function post(route: Route, ip: string) {
  return route.POST(new NextRequest('http://localhost/api/pilot/public-interest', {
    method: 'POST',
    body: JSON.stringify({ website: 'http://spam.example' }),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  }));
}

const freshRoute = () => loadReplica<Route>(() => jest.requireActual<Route>('./route'));

beforeEach(() => mockDurableStore.buckets.clear());

describe('POST /api/pilot/public-interest under a burst', () => {
  test('of 20 submissions from one IP sent together, one is admitted', async () => {
    const route = freshRoute();

    const responses = await Promise.all(Array.from({ length: 20 }, () => post(route, '10.5.0.1')));

    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(19);
  });

  test('split across two replicas sharing the durable store, still one', async () => {
    const restore = enableDurable();
    try {
      const replicas = [freshRoute(), freshRoute()];

      const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => post(replicas[i % 2], '10.5.1.1')));

      expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    } finally {
      restore();
    }
  });
});
