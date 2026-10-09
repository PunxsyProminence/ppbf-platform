import { NextRequest } from 'next/server';

import { createFakeDurableRateLimitStore, enableDurable, loadReplica } from '@/src/testing/fakeDurableRateLimitStore';

// CL-A4 follow-up: change-pin read the buckets, awaited the current-PIN check
// (scrypt) and recorded the failure afterwards, so a burst of guesses at the
// current PIN all passed the read. rateLimit.ts is left real; the durable half
// runs on a shared fake store only in the replica test.
const mockDurableStore = createFakeDurableRateLimitStore();
const mockChangeOwnPin = jest.fn();
const mockPrincipal = jest.fn();

jest.mock('@/src/server/pilot/db', () => ({
  ...jest.requireActual('@/src/server/pilot/db'),
  withPoolClient: (work: never) => mockDurableStore.withPoolClient(work),
}));

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipalAllowingPinChange: (...args: unknown[]) => mockPrincipal(...args),
}));

jest.mock('@/src/server/pilot/auth', () => ({
  changeOwnPin: (...args: unknown[]) => mockChangeOwnPin(...args),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(async () => undefined),
}));

type Route = typeof import('./route');

const NEW_PIN = '482917';

function principal(accountId: string) {
  return {
    accountId,
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: accountId,
    sessionToken: `token-${accountId}`,
    authProvider: 'ppbf_local',
    mustChangePin: true,
  };
}

function post(route: Route, ip: string, body: Record<string, string>) {
  return route.POST(new NextRequest('http://localhost/api/pilot/auth/change-pin', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  }));
}

function wrongCurrentPinSlowly() {
  mockChangeOwnPin.mockImplementation(
    () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Unauthorized: current PIN is incorrect')), 20)),
  );
}

const freshRoute = () => loadReplica<Route>(() => jest.requireActual<Route>('./route'));

beforeEach(() => {
  mockDurableStore.buckets.clear();
  mockChangeOwnPin.mockReset();
  mockPrincipal.mockReset().mockResolvedValue(principal('ath-burst'));
});

describe('POST /api/pilot/auth/change-pin under a burst of parallel guesses', () => {
  test('of 20 guesses at one account\'s current PIN sent together, one reaches the PIN check', async () => {
    wrongCurrentPinSlowly();
    const route = freshRoute();

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post(route, `10.2.0.${i + 1}`, { current_pin: String(100000 + i), new_pin: NEW_PIN })),
    );

    expect(mockChangeOwnPin).toHaveBeenCalledTimes(1);
    expect(responses.filter((r) => r.status === 429)).toHaveLength(19);
  });

  test('split across two replicas sharing the durable store, still one', async () => {
    const restore = enableDurable();
    try {
      wrongCurrentPinSlowly();
      const replicas = [freshRoute(), freshRoute()];

      await Promise.all(
        Array.from({ length: 20 }, (_, i) => post(replicas[i % 2], `10.2.1.${i + 1}`, { current_pin: String(100000 + i), new_pin: NEW_PIN })),
      );

      expect(mockChangeOwnPin).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  // The gym's tablets share one public IP; the IP bucket stays check-then-record.
  test('a class changing its starting PINs together from one IP is not throttled', async () => {
    mockChangeOwnPin.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 20)));
    mockPrincipal.mockImplementation(async (request: NextRequest) => principal(request.headers.get('x-account') ?? ''));
    const route = freshRoute();

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, i) => route.POST(new NextRequest('http://localhost/api/pilot/auth/change-pin', {
        method: 'POST',
        body: JSON.stringify({ current_pin: '000000', new_pin: NEW_PIN }),
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.2.9.9', 'x-account': `ath-class-${i}` },
      }))),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(12).fill(200));
  });

  test('a new PIN the rules refuse is a 400 and costs nothing: the next real attempt goes straight through', async () => {
    wrongCurrentPinSlowly();
    const route = freshRoute();

    for (const weak of ['111111', '123456', '12345']) {
      expect((await post(route, '10.2.2.1', { current_pin: '000000', new_pin: weak })).status).toBe(400);
    }
    expect((await post(route, '10.2.2.1', { current_pin: NEW_PIN, new_pin: NEW_PIN })).status).toBe(400);
    expect(mockChangeOwnPin).not.toHaveBeenCalled();

    expect((await post(route, '10.2.2.1', { current_pin: '000000', new_pin: NEW_PIN })).status).toBe(401);
    expect(mockChangeOwnPin).toHaveBeenCalledTimes(1);
  });
});
