import { NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { listRecentSparringEntries } from '@/src/server/pilot/formulas/repository';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import * as route from './route';

/**
 * GET on the observations route: the list behind the sparring page's "Fix a
 * number" (lane L50). Same two gates as POST, in the same order, and an
 * enumerated projection -- no source reference or idempotency key leaves.
 * The SQL itself is proved against Postgres in
 * src/server/pilot/formulas/sparringCorrection.pg.test.ts.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowReadiness', () => ({
  assertShadowRuntimeReadiness: jest.fn(),
}));
jest.mock('@/src/server/pilot/formulas/repository', () => {
  const actual = jest.requireActual('@/src/server/pilot/formulas/repository');
  return { ...actual, listRecentSparringEntries: jest.fn() };
});
jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  withTransaction: jest.fn(),
}));

const mockRequirePrincipal = jest.mocked(requirePrincipal);
const mockAssertAccess = jest.mocked(assertActorCanAccessAthlete);
const mockReadiness = jest.mocked(assertShadowRuntimeReadiness);
const mockList = jest.mocked(listRecentSparringEntries);

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'athlete-account-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'athlete-1',
    sessionToken: 'session-token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function getRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/pilot/shadow/formulas/observations${query}`);
}

const STORED_LANDED = Object.freeze({
  observationId: 'obs-landed',
  organizationId: 'org-1',
  athleteId: 'athlete-1',
  contextId: 'sparring_1000',
  kind: 'punch_landed' as const,
  value: 5,
  unit: 'count' as const,
  dimensions: { punchType: 'Jab' },
  observedAt: '2026-10-17T15:00:00.000Z',
  source: { type: 'manual' as const, quality: 'moderate' as const, referenceId: 'digest-of-account' },
  idempotencyKey: 'sparring_1000-punch_landed',
  supersedesObservationId: null,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockAssertAccess.mockResolvedValue(undefined as never);
  mockReadiness.mockResolvedValue(undefined as never);
  mockList.mockResolvedValue([
    { contextId: 'sparring_1000', observedAt: STORED_LANDED.observedAt, observations: [STORED_LANDED] },
  ]);
});

describe('GET /api/pilot/shadow/formulas/observations (recent sparring entries)', () => {
  test('exists: the sparring page has something to list entries from', () => {
    expect(typeof route.GET).toBe('function');
  });

  test('checks access to the named athlete, then answers an enumerated projection', async () => {
    const response = await route.GET(getRequest('?athlete_id=athlete-1'));

    expect(response.status).toBe(200);
    expect(mockAssertAccess).toHaveBeenCalledWith(principal(), 'athlete-1');
    expect(mockList).toHaveBeenCalledWith({ organizationId: 'org-1', athleteId: 'athlete-1', limit: 5 });
    expect(await response.json()).toEqual({
      ok: true,
      entries: [{
        contextId: 'sparring_1000',
        observedAt: '2026-10-17T15:00:00.000Z',
        observations: [{
          observationId: 'obs-landed',
          kind: 'punch_landed',
          value: 5,
          unit: 'count',
          dimensions: { punchType: 'Jab' },
          observedAt: '2026-10-17T15:00:00.000Z',
        }],
      }],
    });
  });

  test('a refused athlete is never read', async () => {
    // The message assertActorCanAccessAthlete really throws (access.ts).
    mockAssertAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

    const response = await route.GET(getRequest('?athlete_id=someone-else'));

    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('a parent is refused by role before any athlete is resolved', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent', athleteId: null }));

    const response = await route.GET(getRequest('?athlete_id=athlete-1'));

    expect(response.status).toBe(403);
    expect(mockAssertAccess).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });

  test('no athlete named is a bad request, not an empty list', async () => {
    const response = await route.GET(getRequest(''));

    expect(response.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});
