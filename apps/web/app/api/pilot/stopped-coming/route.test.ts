import { NextRequest } from 'next/server';

import { GET } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listStoppedComing } from '@/src/server/pilot/stoppedComing';

/*
 * The stopped-coming route (lane W4-6, SC-1). Who is listed is
 * stoppedComing.test.ts and stoppedComing.pg.test.ts; this file pins who may
 * ask: coach, organization_admin and admin (Overwatch, W4-6 GO, condition 1),
 * with the module's own staff-membership refusal passed through.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/stoppedComing', () => ({ listStoppedComing: jest.fn() }));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockList = listStoppedComing as jest.Mock;

const URL = 'http://localhost/api/pilot/stopped-coming';
const LIST = {
  gap_days: 14,
  is_default: true,
  today: '2026-11-25',
  athletes: [{ athlete_id: 'a-1', full_name: 'Ada', last_came_day: '2026-11-01', days_since_came: 24 }],
};

function principal(role: string, organizationId = 'org-1') {
  return { accountId: `acct-${role}`, role, organizationId, athleteId: null, sessionToken: 'secret', authProvider: 'microsoft' };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue(LIST);
});

it.each(['coach', 'organization_admin', 'admin'])('a %s reads its own gym\'s list', async (role) => {
  mockPrincipal.mockResolvedValue(principal(role));
  const response = await GET(new NextRequest(URL));
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await response.json()).toEqual({ ok: true, ...LIST });
  expect(mockList).toHaveBeenCalledTimes(1);
  const [actor, today] = mockList.mock.calls[0];
  expect(actor).toMatchObject({ accountId: `acct-${role}`, role, organizationId: 'org-1' });
  expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

it.each(['athlete', 'parent', 'board', 'volunteer', 'staff', 'platform_owner'])('a %s is refused before anything is read', async (role) => {
  mockPrincipal.mockResolvedValue(principal(role));
  const response = await GET(new NextRequest(URL));
  expect(response.status).toBe(403);
  expect(mockList).not.toHaveBeenCalled();
});

it('a coach with no active staff membership here is refused (the module\'s 403 passes through)', async () => {
  mockPrincipal.mockResolvedValue(principal('coach'));
  mockList.mockImplementation(async () => {
    const { ForbiddenError } = jest.requireActual('@/src/server/pilot/errors');
    throw new ForbiddenError('Forbidden: only a coach or the gym admin of this gym reads who has stopped coming');
  });
  const response = await GET(new NextRequest(URL));
  expect(response.status).toBe(403);
});

it('asks for the gym-local day, not the UTC day', async () => {
  // 03:00 UTC on 26 November is still 25 November in the gym (America/New_York).
  jest.useFakeTimers({ now: new Date('2026-11-26T03:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  try {
    mockPrincipal.mockResolvedValue(principal('coach'));
    const response = await GET(new NextRequest(URL));
    expect(response.status).toBe(200);
    expect(mockList.mock.calls[0][1]).toBe('2026-11-25');
  } finally {
    jest.useRealTimers();
  }
});

it('reads the organization from the session, and refuses a query that names one', async () => {
  mockPrincipal.mockResolvedValue(principal('coach'));
  const response = await GET(new NextRequest(`${URL}?organization_id=org-2`));
  expect(response.status).toBe(400);
  expect(mockList).not.toHaveBeenCalled();
});

it('a caller with no session is refused before anything is read', async () => {
  mockPrincipal.mockRejectedValue(new Error('Unauthorized'));
  const response = await GET(new NextRequest(URL));
  expect(response.status).toBe(401);
  expect(mockList).not.toHaveBeenCalled();
});
