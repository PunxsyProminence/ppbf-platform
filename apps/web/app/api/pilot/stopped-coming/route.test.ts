import { NextRequest } from 'next/server';

import { GET, PUT } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import { listStoppedComing, setStoppedComingReachedOut } from '@/src/server/pilot/stoppedComing';

/*
 * The stopped-coming route (lane W4-6, SC-1; the reached-out mark, SC-3a-2).
 * Who is listed, and what a mark does, is stoppedComing.test.ts,
 * stoppedComing.pg.test.ts and reachedOutMarks.pg.test.ts; this file pins who
 * may ask: coach, organization_admin and admin on both handlers (Overwatch,
 * W4-6 GO, condition 1; on #2163, answer A), with the module's own
 * staff-membership refusal passed through, and what the PUT takes.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/stoppedComing', () => ({ listStoppedComing: jest.fn(), setStoppedComingReachedOut: jest.fn() }));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockList = listStoppedComing as jest.Mock;
const mockMark = setStoppedComingReachedOut as jest.Mock;

const URL = 'http://localhost/api/pilot/stopped-coming';
const LIST = {
  gap_days: 14,
  is_default: true,
  today: '2026-11-25',
  athletes: [{
    athlete_id: 'a-1', full_name: 'Ada', last_came_day: '2026-11-01', days_since_came: 24,
    reached_out: { by_name: 'Coach Jordan', by_role: 'coach', on_day: '2026-11-20' },
  }],
};

function principal(role: string, organizationId = 'org-1') {
  return { accountId: `acct-${role}`, role, organizationId, athleteId: null, sessionToken: 'secret', authProvider: 'microsoft' };
}

function put(body: unknown, url = URL) {
  return PUT(new NextRequest(url, { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body) }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockList.mockResolvedValue(LIST);
  mockMark.mockResolvedValue('marked');
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

describe('PUT: the reached-out mark (SC-3a-2)', () => {
  it.each([
    ['coach', true, 'marked'],
    ['organization_admin', false, 'taken_back'],
    ['admin', true, 'already_marked'],
  ])('a %s marks or takes back for its own gym, and gets the outcome only', async (role, reachedOut, outcome) => {
    mockPrincipal.mockResolvedValue(principal(role));
    mockMark.mockResolvedValue(outcome);
    const response = await put({ athlete_id: 'a-1', reached_out: reachedOut });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ ok: true, outcome });
    expect(mockMark).toHaveBeenCalledTimes(1);
    const [actor, athleteId, sent, today] = mockMark.mock.calls[0];
    expect(actor).toMatchObject({ accountId: `acct-${role}`, role, organizationId: 'org-1' });
    expect([athleteId, sent]).toEqual(['a-1', reachedOut]);
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each(['athlete', 'parent', 'board', 'volunteer', 'staff', 'platform_owner'])('a %s is refused before anything is written', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    const response = await put({ athlete_id: 'a-1', reached_out: true });
    expect(response.status).toBe(403);
    expect(mockMark).not.toHaveBeenCalled();
  });

  it.each(['athlete', 'parent'])('a %s sending a broken body is refused for its role (403), not for its body', async (role) => {
    mockPrincipal.mockResolvedValue(principal(role));
    for (const body of ['not json', [1], { athlete_id: 'a-1', reached_out: true, note: 'called mum' }]) {
      expect((await put(body)).status).toBe(403);
    }
    expect(mockMark).not.toHaveBeenCalled();
  });

  it.each([
    ['no body', ''],
    ['not JSON', 'not json'],
    ['an array', [{ athlete_id: 'a-1', reached_out: true }]],
    ['an empty object', {}],
    ['athlete_id only', { athlete_id: 'a-1' }],
    ['reached_out only', { reached_out: true }],
    ['a note (who and when only, no free text)', { athlete_id: 'a-1', reached_out: true, note: 'called mum' }],
    ['the organization in the body', { athlete_id: 'a-1', reached_out: true, organization_id: 'org-2' }],
    ['a different field', { athlete: 'a-1', reached_out: true }],
    ['an empty athlete_id', { athlete_id: '  ', reached_out: true }],
    ['a number for athlete_id', { athlete_id: 7, reached_out: true }],
    ['reached_out as text', { athlete_id: 'a-1', reached_out: 'true' }],
    ['reached_out as a number', { athlete_id: 'a-1', reached_out: 1 }],
    ['reached_out null', { athlete_id: 'a-1', reached_out: null }],
  ])('refuses %s (400) without writing', async (_label, body) => {
    mockPrincipal.mockResolvedValue(principal('coach'));
    const response = await put(body);
    expect(response.status).toBe(400);
    expect(mockMark).not.toHaveBeenCalled();
  });

  it('refuses a query field on the write, so no request can name a gym', async () => {
    mockPrincipal.mockResolvedValue(principal('coach'));
    const response = await put({ athlete_id: 'a-1', reached_out: true }, `${URL}?organization_id=org-2`);
    expect(response.status).toBe(400);
    expect(mockMark).not.toHaveBeenCalled();
  });

  it('the organization comes from the session: the mark is asked for the session\'s gym', async () => {
    mockPrincipal.mockResolvedValue(principal('coach', 'org-2'));
    await put({ athlete_id: 'a-1', reached_out: true });
    expect(mockMark.mock.calls[0][0]).toMatchObject({ organizationId: 'org-2' });
  });

  it('the athlete id is trimmed', async () => {
    mockPrincipal.mockResolvedValue(principal('coach'));
    await put({ athlete_id: '  a-1 ', reached_out: true });
    expect(mockMark.mock.calls[0][1]).toBe('a-1');
  });

  it('marks on the gym-local day, not the UTC day', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-26T03:00:00Z'), doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    try {
      mockPrincipal.mockResolvedValue(principal('coach'));
      expect((await put({ athlete_id: 'a-1', reached_out: true })).status).toBe(200);
      expect(mockMark.mock.calls[0][3]).toBe('2026-11-25');
    } finally {
      jest.useRealTimers();
    }
  });

  it('the module\'s refusals pass through: no staff membership here (403), not a live athlete of this gym (404), not on the list now (409)', async () => {
    const { ConflictError, ForbiddenError, NotFoundError } = jest.requireActual('@/src/server/pilot/errors');
    mockPrincipal.mockResolvedValue(principal('coach'));
    mockMark.mockRejectedValueOnce(new ForbiddenError('Forbidden: only a coach or the gym admin of this gym marks who was reached out to'));
    expect((await put({ athlete_id: 'a-1', reached_out: true })).status).toBe(403);
    mockMark.mockRejectedValueOnce(new NotFoundError('Athlete not found.'));
    const response = await put({ athlete_id: 'a-gone', reached_out: true });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Athlete not found.');
    mockMark.mockRejectedValueOnce(new ConflictError('This athlete is not on the stopped-coming list now. Reload the page.', 'NOT_ON_STOPPED_COMING_LIST'));
    const notListed = await put({ athlete_id: 'a-1', reached_out: true });
    expect(notListed.status).toBe(409);
    expect(await notListed.json()).toMatchObject({ code: 'NOT_ON_STOPPED_COMING_LIST' });
  });

  it('a caller with no session is refused before anything is written', async () => {
    mockPrincipal.mockRejectedValue(new Error('Unauthorized'));
    expect((await put({ athlete_id: 'a-1', reached_out: true })).status).toBe(401);
    expect(mockMark).not.toHaveBeenCalled();
  });
});
