// The intake review queue is the caller's own gym's, so it is gym data: the
// gym's admin, coaches and parents may (each within their own reach, decided
// in the read model), the platform owner may not (OD-2026-10-10-004 ruling 3).
// The refusal lands before the readiness check and before the read.

import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { assertShadowRuntimeReadiness } from '@/src/server/pilot/shadowReadiness';
import { getShadowReviewProjection } from '@/src/server/pilot/shadowReadModels';

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));
jest.mock('@/src/server/pilot/shadowReadiness', () => ({ assertShadowRuntimeReadiness: jest.fn() }));
jest.mock('@/src/server/pilot/shadowReadModels', () => ({ getShadowReviewProjection: jest.fn() }));

const mockPrincipal = jest.mocked(requirePrincipal);
const mockReadiness = jest.mocked(assertShadowRuntimeReadiness);
const mockProjection = jest.mocked(getShadowReviewProjection);

function as(role: string) {
  mockPrincipal.mockResolvedValue({
    accountId: `${role}-1`, organizationId: 'org-1', role, athleteId: null,
  } as never);
}

function post(body: Record<string, unknown> = {}) {
  return POST(new NextRequest('http://localhost/api/pilot/shadow/review-projection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  jest.resetAllMocks();
  mockReadiness.mockResolvedValue(undefined as never);
  mockProjection.mockResolvedValue({ items: [{ intake_case_id: 'case-1' }], total: 1 } as never);
});

test.each([
  ['an empty body', {}],
  ['a named case', { intake_case_id: 'case-1' }],
  ['a status filter', { status: 'pending_review', limit: 5 }],
])('refuses the platform owner with %s, and reads nothing', async (_label, body) => {
  as('platform_owner');

  const response = await post(body);

  expect(response.status).toBe(403);
  expect(mockReadiness).not.toHaveBeenCalled();
  expect(mockProjection).not.toHaveBeenCalled();
});

test.each(['organization_admin', 'admin', 'coach', 'parent'])('%s reads its own gym\'s queue', async (role) => {
  as(role);

  const response = await post({ intake_case_id: 'case-1', status: 'pending_review' });

  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toEqual({
    ok: true,
    organization_id: 'org-1',
    queue: [{ intake_case_id: 'case-1' }],
    total: 1,
  });
  expect(mockProjection).toHaveBeenCalledTimes(1);
  expect(mockProjection.mock.calls[0][0]).toEqual({
    organizationId: 'org-1',
    actorAccountId: `${role}-1`,
    actorRole: role,
    athleteId: null,
  });
  expect(mockProjection.mock.calls[0][1]).toMatchObject({ entityId: 'case-1', eventName: 'pending_review' });
});

test.each(['athlete', 'board', 'staff', 'volunteer'])('%s is refused, as before', async (role) => {
  as(role);

  expect((await post()).status).toBe(403);
  expect(mockProjection).not.toHaveBeenCalled();
});
