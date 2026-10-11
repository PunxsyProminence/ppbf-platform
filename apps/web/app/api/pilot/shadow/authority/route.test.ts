// The authority-check listing reads the caller's own gym's governance rows, so
// it is gym data: the gym's admin and coaches may, the platform owner may not
// (OD-2026-10-10-004 ruling 3). The refusal lands before the readiness check
// and before the read.

import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { listShadowAuthorityChecks } from '@/src/server/pilot/shadowReadModels';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowReadiness', () => ({ assertShadowRuntimeReadiness: jest.fn() }));
jest.mock('@/src/server/pilot/shadowReadModels', () => ({ listShadowAuthorityChecks: jest.fn() }));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockReadiness = jest.mocked(assertShadowRuntimeReadiness);
const mockList = jest.mocked(listShadowAuthorityChecks);

function as(role: string) {
  mockPrincipal.mockResolvedValue({
    accountId: `${role}-1`, organizationId: 'org-1', role, athleteId: null,
  } as never);
}

function post(body: Record<string, unknown> = {}) {
  return POST(new NextRequest('http://localhost/api/pilot/shadow/authority', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  jest.resetAllMocks();
  mockReadiness.mockResolvedValue(undefined as never);
  mockList.mockResolvedValue([{ authority_check_id: 'check-1' }] as never);
});

test.each([
  ['an empty body', {}],
  ['filters', { limit: 5, action: 'upload', allowed: false, correlation_id: 'case-1' }],
])('refuses the platform owner with %s, and reads nothing', async (_label, body) => {
  as('platform_owner');

  const response = await post(body);

  expect(response.status).toBe(403);
  expect(mockReadiness).not.toHaveBeenCalled();
  expect(mockList).not.toHaveBeenCalled();
});

test.each(['organization_admin', 'admin', 'coach'])('%s lists its own gym\'s checks', async (role) => {
  as(role);

  const response = await post({ limit: 5, action: 'upload' });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    organization_id: 'org-1',
    authority_checks: [{ authority_check_id: 'check-1' }],
  });
  expect(mockList).toHaveBeenCalledTimes(1);
  expect(mockList.mock.calls[0][0]).toEqual({
    organizationId: 'org-1',
    actorAccountId: `${role}-1`,
    actorRole: role,
    athleteId: null,
  });
  expect(mockList.mock.calls[0][1]).toMatchObject({ limit: 5, action: 'upload' });
});

test.each(['athlete', 'parent', 'board', 'staff', 'volunteer'])('%s is refused, as before', async (role) => {
  as(role);

  expect((await post()).status).toBe(403);
  expect(mockList).not.toHaveBeenCalled();
});
