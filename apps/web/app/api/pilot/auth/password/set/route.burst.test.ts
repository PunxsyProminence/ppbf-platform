import { NextRequest } from 'next/server';

import { createFakeDurableRateLimitStore, enableDurable, loadReplica } from '@/src/testing/fakeDurableRateLimitStore';

// CL-A4 follow-up. In memory the hash allowance was already checked and
// counted in one tick; the durable half read the bucket and wrote afterwards,
// so a burst on one link session split across replicas ran the hash on each.
// Two copies of the route, each with its own in-memory limiter, share one
// durable store here.
const mockDurableStore = createFakeDurableRateLimitStore();
const mockHashRan = jest.fn();

jest.mock('@/src/server/pilot/db', () => ({
  ...jest.requireActual('@/src/server/pilot/db'),
  withPoolClient: (work: never) => mockDurableStore.withPoolClient(work),
}));

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: async () => ({
    accountId: 'parent-burst',
    role: 'parent',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'link-session',
    authProvider: 'microsoft',
  }),
}));

// What the real function does around the hash: the route's hook, then the hash.
jest.mock('@/src/server/pilot/parentPassword', () => ({
  ...jest.requireActual('@/src/server/pilot/parentPassword'),
  setOwnPasswordFromLinkSession: async (input: { beforeHash: () => Promise<void> }) => {
    await input.beforeHash();
    await new Promise((resolve) => setTimeout(resolve, 20));
    mockHashRan();
  },
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(async () => undefined),
}));

type Route = typeof import('./route');

function post(route: Route, ip: string) {
  return route.POST(new NextRequest('http://localhost/api/pilot/auth/password/set', {
    method: 'POST',
    body: JSON.stringify({ password: 'three small boats' }),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  }));
}

test('20 sets on one link session split across two replicas run the hash once', async () => {
  const restore = enableDurable();
  try {
    const replicas = [loadReplica<Route>(() => jest.requireActual<Route>('./route')), loadReplica<Route>(() => jest.requireActual<Route>('./route'))];

    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => post(replicas[i % 2], `10.7.0.${i + 1}`)));

    expect(mockHashRan).toHaveBeenCalledTimes(1);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(19);
  } finally {
    restore();
  }
});
