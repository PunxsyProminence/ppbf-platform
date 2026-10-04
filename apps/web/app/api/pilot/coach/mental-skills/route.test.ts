import { NextRequest } from 'next/server';

import * as route from './route';
import { readMentalSkills } from '@/src/server/pilot/athleteMentalSkills';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/athleteMentalSkills', () => ({
  readMentalSkills: jest.fn().mockResolvedValue({ current_cue: null, imagery_sessions: [] }),
}));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockRead = readMentalSkills as jest.Mock;

afterEach(() => jest.clearAllMocks());

const principal = (role: PilotPrincipal['role']) =>
  ({ accountId: 'acct-c', role, organizationId: 'org-1', athleteId: null, sessionToken: 't', authProvider: 'microsoft' }) as PilotPrincipal;
const get = (query = '') => new NextRequest(`http://localhost/api/pilot/coach/mental-skills${query}`);

test('read only: the route exports GET and no write verb', () => {
  expect(Object.keys(route).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))).toEqual(['GET']);
});

test('coach and org admin read the named athlete through the module gate', async () => {
  for (const role of ['coach', 'organization_admin', 'admin'] as const) {
    mockPrincipal.mockResolvedValue(principal(role));
    expect((await route.GET(get('?athlete_id=ath-1'))).status).toBe(200);
    expect(mockRead).toHaveBeenLastCalledWith(expect.objectContaining({ role }), 'ath-1');
  }
});

test('athlete_id is required', async () => {
  mockPrincipal.mockResolvedValue(principal('coach'));
  expect((await route.GET(get())).status).toBe(400);
  expect(mockRead).not.toHaveBeenCalled();
});

test('family, platform and board roles have no path here', async () => {
  for (const role of ['athlete', 'parent', 'platform_owner', 'board'] as const) {
    mockPrincipal.mockResolvedValue(principal(role));
    expect((await route.GET(get('?athlete_id=ath-1'))).status).toBe(403);
  }
  expect(mockRead).not.toHaveBeenCalled();
});

test('a refusal from the module gate comes back as 403', async () => {
  mockPrincipal.mockResolvedValue(principal('coach'));
  mockRead.mockRejectedValueOnce(new Error('Forbidden: coach is not assigned'));
  expect((await route.GET(get('?athlete_id=ath-other'))).status).toBe(403);
});
