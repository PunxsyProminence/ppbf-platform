import { NextRequest } from 'next/server';

import { DELETE, GET, POST } from './route';
import { athleteIdsForCoach } from '@/src/server/pilot/access';
import { organizationActionableRoster } from '@/src/server/pilot/coachAthleteRoster';
import { requirePrincipal } from '@/src/server/pilot/http';
import { addRestMark, clearRestMark, listRestMarks } from '@/src/server/pilot/restMarks';

/*
 * The route over restMarks.ts (lane R6-b1). Who may reach which athlete is
 * proven against real rows in restMarks.pg.test.ts; with the module mocked,
 * this file asserts what only the route decides: roles refused before the
 * module runs, the identity handed down is the SESSION's, the body and query
 * take exactly their fields (a reason is refused, never dropped -- Overwatch
 * 2026-11-19), the GET roster is the analytics roster, and no marker account
 * id leaves the server.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, athleteIdsForCoach: jest.fn() };
});

jest.mock('@/src/server/pilot/coachAthleteRoster', () => ({ organizationActionableRoster: jest.fn() }));

jest.mock('@/src/lib/gymTime', () => {
  const actual = jest.requireActual('@/src/lib/gymTime');
  return { ...actual, gymDayIso: jest.fn(() => '2026-11-19') };
});

jest.mock('@/src/server/pilot/restMarks', () => {
  const actual = jest.requireActual('@/src/server/pilot/restMarks');
  return { ...actual, addRestMark: jest.fn(), clearRestMark: jest.fn(), listRestMarks: jest.fn() };
});

const mockPrincipal = requirePrincipal as jest.Mock;
const mockAdd = addRestMark as jest.Mock;
const mockClear = clearRestMark as jest.Mock;
const mockList = listRestMarks as jest.Mock;
const mockCoachIds = athleteIdsForCoach as jest.Mock;
const mockRoster = organizationActionableRoster as jest.Mock;

const COACH = {
  accountId: 'acct-coach',
  role: 'coach',
  organizationId: 'org-1',
  athleteId: null,
  sessionToken: 'secret-token',
  authProvider: 'microsoft',
};
const ADMIN = { ...COACH, accountId: 'acct-admin', role: 'organization_admin' };
const ACTOR = { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null };
const MARK_ID = '4f9d2c1e-6b3a-4e8f-9c2d-1a2b3c4d5e6f';
const MARK = {
  mark_id: MARK_ID,
  athlete_id: 'ath-1',
  kind: 'rest',
  first_day: '2026-11-13',
  last_day: '2026-11-19',
  marked_at: '2026-11-19T15:00:00.000Z',
};
const GOOD = { athlete_id: 'ath-1', kind: 'rest', first_day: '2026-11-13', last_day: '2026-11-19' };
const URL_BASE = 'http://localhost/api/pilot/coach/rest-marks';

function get(query = '') {
  return GET(new NextRequest(`${URL_BASE}${query}`));
}
function post(body: unknown) {
  return POST(new NextRequest(URL_BASE, {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }));
}
function del(query: string, body?: string) {
  return DELETE(new NextRequest(`${URL_BASE}${query}`, { method: 'DELETE', ...(body === undefined ? {} : { body }) }));
}

beforeEach(() => {
  mockPrincipal.mockResolvedValue(COACH);
});
afterEach(() => {
  jest.clearAllMocks();
});

describe('roles refused before the module runs', () => {
  test.each(['athlete', 'parent', 'board', 'volunteer', 'platform_owner'])('%s gets 403 on every method', async (role) => {
    mockPrincipal.mockResolvedValue({ ...COACH, role });
    expect((await get()).status).toBe(403);
    expect((await post(GOOD)).status).toBe(403);
    expect((await del(`?athlete_id=ath-1&mark_id=${MARK_ID}`)).status).toBe(403);
    expect(mockAdd).not.toHaveBeenCalled();
    expect(mockClear).not.toHaveBeenCalled();
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('POST: one mark, no reason', () => {
  test('hands the session identity and the four fields down; 201 for a new mark, 200 for the same one', async () => {
    mockAdd.mockResolvedValueOnce({ mark: MARK, created: true }).mockResolvedValueOnce({ mark: MARK, created: false });
    const first = await post({ ...GOOD, athlete_id: '  ath-1  ' });
    expect(first.status).toBe(201);
    expect(mockAdd).toHaveBeenCalledWith({
      actor: ACTOR, athleteId: 'ath-1', kind: 'rest', firstDay: '2026-11-13', lastDay: '2026-11-19', today: '2026-11-19',
    });
    const body = await first.json();
    expect(body).toEqual({
      ok: true, created: true,
      mark: { mark_id: MARK_ID, athlete_id: 'ath-1', kind: 'rest', first_day: '2026-11-13', last_day: '2026-11-19' },
    });
    expect((await post(GOOD)).status).toBe(200);
  });

  test.each([
    ['reason', 'ill'],
    ['note', 'flu'],
    ['health_reason', ''],
    ['marked_by_account_id', 'acct-someone-else'],
    ['organization_id', 'org-2'],
  ])('a body carrying %s is refused with 400 and nothing is written', async (field, value) => {
    const response = await post({ ...GOOD, [field]: value });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/records no reason/);
    expect(JSON.stringify(body)).toContain(field);
    expect(mockAdd).not.toHaveBeenCalled();
  });

  test('a non-object body or a missing athlete is refused', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post([GOOD])).status).toBe(400);
    expect((await post({ ...GOOD, athlete_id: '  ' })).status).toBe(400);
    expect(mockAdd).not.toHaveBeenCalled();
  });
});

describe('DELETE: undo takes its two ids and nothing else', () => {
  test('clears the named mark as the session', async () => {
    mockClear.mockResolvedValue(undefined);
    const response = await del(`?athlete_id=ath-1&mark_id=${MARK_ID}`);
    expect(response.status).toBe(200);
    expect(mockClear).toHaveBeenCalledWith({ actor: ACTOR, athleteId: 'ath-1', markId: MARK_ID });
  });

  test('an extra query field or any body is refused before the module runs', async () => {
    expect((await del(`?athlete_id=ath-1&mark_id=${MARK_ID}&reason=ill`)).status).toBe(400);
    expect((await del(`?athlete_id=ath-1&mark_id=${MARK_ID}`, JSON.stringify({ reason: 'ill' }))).status).toBe(400);
    expect((await del(`?mark_id=${MARK_ID}`)).status).toBe(400);
    expect(mockClear).not.toHaveBeenCalled();
  });
});

describe('GET: the analytics roster, the 5 load weeks, no marker ids', () => {
  test("a coach reads marks for athleteIdsForCoach's athletes over Rule 6's window", async () => {
    mockCoachIds.mockResolvedValue(['ath-1', 'ath-2']);
    mockList.mockResolvedValue([{ ...MARK, marked_by_account_id: 'acct-coach' }]);
    const response = await get();
    expect(response.status).toBe(200);
    expect(mockCoachIds).toHaveBeenCalledWith('org-1', 'acct-coach');
    expect(mockList).toHaveBeenCalledWith(ACTOR, ['ath-1', 'ath-2'], '2026-10-16', '2026-11-19');
    const body = await response.json();
    expect(body.weeks).toHaveLength(5);
    expect(body.weeks[0]).toEqual({ week_index: 0, first_day: '2026-11-13', last_day: '2026-11-19' });
    expect(body.kinds).toEqual(['rest', 'away']);
    expect(body.marks).toEqual([
      { mark_id: MARK_ID, athlete_id: 'ath-1', kind: 'rest', first_day: '2026-11-13', last_day: '2026-11-19' },
    ]);
    expect(JSON.stringify(body)).not.toMatch(/acct-/);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });

  test("an organization admin reads the gym's live roster", async () => {
    mockPrincipal.mockResolvedValue(ADMIN);
    mockRoster.mockResolvedValue([{ athlete_id: 'ath-1' }, { athlete_id: 'ath-9' }]);
    mockList.mockResolvedValue([]);
    expect((await get()).status).toBe(200);
    expect(mockList).toHaveBeenCalledWith(
      { accountId: 'acct-admin', role: 'organization_admin', organizationId: 'org-1', athleteId: null },
      ['ath-1', 'ath-9'],
      '2026-10-16',
      '2026-11-19',
    );
  });

  test('a query field is refused: there is no "all" or "athlete" switch to widen the roster', async () => {
    expect((await get('?athlete_id=ath-9')).status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });
});
