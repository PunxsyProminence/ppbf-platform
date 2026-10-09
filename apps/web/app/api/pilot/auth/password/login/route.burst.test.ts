import { NextRequest } from 'next/server';

import { createFakeDurableRateLimitStore, enableDurable, loadReplica } from '@/src/testing/fakeDurableRateLimitStore';

// CL-A4 follow-up. In memory this route already checked and counted in one
// tick; the durable half read every bucket and wrote afterwards, so a burst
// split across replicas passed every read. Two copies of the route, each with
// its own in-memory limiter, share one durable store here.
const mockDurableStore = createFakeDurableRateLimitStore();
const mockVerify = jest.fn();

jest.mock('@/src/server/pilot/db', () => ({
  ...jest.requireActual('@/src/server/pilot/db'),
  withPoolClient: (work: never) => mockDurableStore.withPoolClient(work),
}));

jest.mock('@/src/server/pilot/parentPasswordSignIn', () => ({
  ...jest.requireActual('@/src/server/pilot/parentPasswordSignIn'),
  loginWithEmailAndPassword: (...args: unknown[]) => mockVerify(...args),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(async () => undefined),
}));

type Route = typeof import('./route');

function post(route: Route, email: string, ip: string) {
  return route.POST(new NextRequest('http://localhost/api/pilot/auth/password/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'not the password' }),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  }));
}

let restoreDurable: () => void;
beforeEach(() => {
  restoreDurable = enableDurable();
  mockDurableStore.buckets.clear();
  // A slow wrong answer, the shape of scrypt.
  mockVerify.mockReset().mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(null), 20)));
});
afterEach(() => restoreDurable());

describe('POST /api/pilot/auth/password/login under a burst split across replicas', () => {
  test('of 20 guesses at one address over two replicas, one reaches the password check', async () => {
    const replicas = [loadReplica<Route>(() => jest.requireActual<Route>('./route')), loadReplica<Route>(() => jest.requireActual<Route>('./route'))];

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post(replicas[i % 2], 'burst@example.com', `10.1.0.${i + 1}`)),
    );

    expect(mockVerify).toHaveBeenCalledTimes(1);
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(1);
    expect(statuses.filter((s) => s === 429)).toHaveLength(19);
  });

  test('of 20 guesses across addresses from one IP over two replicas, one reaches the password check', async () => {
    const replicas = [loadReplica<Route>(() => jest.requireActual<Route>('./route')), loadReplica<Route>(() => jest.requireActual<Route>('./route'))];

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => post(replicas[i % 2], `walk-${i}@example.com`, '10.1.9.9')),
    );

    expect(mockVerify).toHaveBeenCalledTimes(1);
  });
});
