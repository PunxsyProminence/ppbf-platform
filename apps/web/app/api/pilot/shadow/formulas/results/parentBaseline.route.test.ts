import { NextRequest } from 'next/server';

import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { listActiveFormulaResults } from '@/src/server/pilot/formulas/repository';
import { requirePrincipal } from '@/src/server/pilot/http';
import { GET } from './route';

/**
 * A parent reads no personal baseline (MVP-09): it is derived from the child's
 * check-in answers, which have no parent surface, and a derived number must
 * not open one (Overwatch QD2, 2026-10-17; lane L50). Everyone else's read is
 * unchanged.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowReadiness', () => ({ assertShadowRuntimeReadiness: jest.fn() }));
jest.mock('@/src/server/pilot/formulas/repository', () => {
  const actual = jest.requireActual('@/src/server/pilot/formulas/repository');
  return { ...actual, listActiveFormulaResults: jest.fn().mockResolvedValue([]) };
});
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn(), withTransaction: jest.fn() }));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockList = jest.mocked(listActiveFormulaResults);

function principal(role: PilotPrincipal['role']): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-1',
    athleteId: role === 'athlete' ? 'ath-1' : null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
  };
}

const request = () => new NextRequest('http://localhost/api/pilot/shadow/formulas/results?athlete_id=ath-1');

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(assertActorCanAccessAthlete).mockResolvedValue(undefined as never);
});

test('a parent read excludes MVP-09', async () => {
  mockPrincipal.mockResolvedValue(principal('parent'));
  expect((await GET(request())).status).toBe(200);
  expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ excludeFormulaIds: ['MVP-09'] }));
});

test.each(['athlete', 'coach', 'organization_admin', 'admin'] as const)('a %s read excludes nothing', async (role) => {
  mockPrincipal.mockResolvedValue(principal(role));
  expect((await GET(request())).status).toBe(200);
  expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ excludeFormulaIds: [] }));
});
