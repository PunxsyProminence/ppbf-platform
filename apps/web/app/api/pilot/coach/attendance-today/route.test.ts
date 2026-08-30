import { NextRequest } from 'next/server';

import { GET } from './route';
import { attendanceOnDay } from '@/src/server/pilot/attendancePrecedence';
import {
  coachAuthorizedRoster,
  organizationActionableRoster,
} from '@/src/server/pilot/coachAthleteRoster';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/*
 * Today's register, for the athletes a staff member may see.
 *
 * WHAT IS ONLY ASSERTABLE HERE. The reconciliation itself is the view's job
 * and is proven in attendancePrecedence.pg.test.ts; the roster contract is
 * proven in athleteIdsForCoach.pg.test.ts. What this file pins is the wiring
 * that a mock can actually falsify:
 *
 *   -- the athlete ids come from the ROSTER CONTRACT, never from the request;
 *   -- the day is computed server-side in gym time, never taken from a caller;
 *   -- a role with no business here is refused before any read happens;
 *   -- marks are returned as marks, with nothing synthesised for the silent.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/coachAthleteRoster', () => ({
  coachAuthorizedRoster: jest.fn(async () => []),
  organizationActionableRoster: jest.fn(async () => []),
}));

jest.mock('@/src/server/pilot/attendancePrecedence', () => ({
  attendanceOnDay: jest.fn(async () => []),
}));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockCoachRoster = coachAuthorizedRoster as jest.Mock;
const mockOrgRoster = organizationActionableRoster as jest.Mock;
const mockAttendance = attendanceOnDay as jest.Mock;

afterEach(() => jest.clearAllMocks());

beforeEach(() => {
  mockCoachRoster.mockResolvedValue([
    { athlete_id: 'ath-1', full_name: 'Rosa D.' },
    { athlete_id: 'ath-2', full_name: 'Jordan P.' },
  ]);
  mockOrgRoster.mockResolvedValue([{ athlete_id: 'ath-9', full_name: 'Whole Gym' }]);
  mockAttendance.mockResolvedValue([]);
});

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-coach-a',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const request = (qs = '') =>
  new NextRequest(`http://localhost/api/pilot/coach/attendance-today${qs}`);

describe('the register is scoped by the roster contract, not by the request', () => {
  test('a coach is asked about exactly the athletes the contract cleared', async () => {
    mockPrincipal.mockResolvedValue(principal());

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(mockCoachRoster).toHaveBeenCalledWith('org-1', 'acct-coach-a');
    expect(mockAttendance.mock.calls[0][1]).toEqual(['ath-1', 'ath-2']);
  });

  test('athlete ids in the query string are ignored entirely', async () => {
    mockPrincipal.mockResolvedValue(principal());

    /* A caller who could name the athletes could name someone else's child
       and read whether they were at the gym today. The ids come from the
       contract or they do not come at all. */
    await GET(request('?athlete_ids=ath-someone-else&athlete_id=ath-99'));

    expect(mockAttendance.mock.calls[0][1]).toEqual(['ath-1', 'ath-2']);
  });

  test('the organization comes from the session, never from the caller', async () => {
    mockPrincipal.mockResolvedValue(principal({ organizationId: 'org-1' }));

    await GET(request('?organization_id=org-2'));

    expect(mockAttendance.mock.calls[0][0]).toBe('org-1');
  });

  test('an admin reads the organization roster, and a coach never does', async () => {
    mockPrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));

    await GET(request());

    expect(mockOrgRoster).toHaveBeenCalledWith('org-1');
    expect(mockCoachRoster).not.toHaveBeenCalled();
    expect(mockAttendance.mock.calls[0][1]).toEqual(['ath-9']);
  });

  test('an athlete is refused before any read happens', async () => {
    mockPrincipal.mockResolvedValue(principal({ role: 'athlete' }));

    const response = await GET(request());

    expect(response.status).toBe(403);
    expect(mockCoachRoster).not.toHaveBeenCalled();
    expect(mockAttendance).not.toHaveBeenCalled();
  });
});

describe('the day is the gym\'s, and it is not negotiable', () => {
  test('the day is computed server-side and a requested one is ignored', async () => {
    mockPrincipal.mockResolvedValue(principal());

    await GET(request('?day=1999-01-01&date=1999-01-01'));

    const day = mockAttendance.mock.calls[0][2];
    expect(day).not.toBe('1999-01-01');
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const body = await (await GET(request())).json();
    expect(body.day).toBe(day);
  });

  test('the day is resolved in gym time, not in UTC', async () => {
    /* The drift this guards: an evening session after 8pm ET falls on the
       NEXT UTC day, so a register computed from a UTC clock asks about
       tomorrow for the whole back half of every training night. Frozen at
       01:30 UTC, which is 21:30 the previous evening at the gym. */
    jest.useFakeTimers().setSystemTime(new Date('2026-08-29T01:30:00Z'));
    try {
      mockPrincipal.mockResolvedValue(principal());
      await GET(request());
      expect(mockAttendance.mock.calls[0][2]).toBe('2026-08-28');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('marks are marks, and silence is not one', () => {
  test('only recorded marks come back, with nothing filled in for the rest', async () => {
    mockPrincipal.mockResolvedValue(principal());
    mockAttendance.mockResolvedValue([
      { athlete_id: 'ath-1', status: 'present', source: 'activity_log' },
    ]);

    const body = await (await GET(request())).json();

    /* ath-2 is on the roster and has no row. It must not appear here as
       'absent': before the register is taken every athlete looks like this,
       and inventing a mark would report a child missed training because
       nobody had ticked them off yet. */
    expect(body.marks).toEqual([
      { athlete_id: 'ath-1', status: 'present', source: 'activity_log' },
    ]);
    /* Scoped to `marks`. ath-2 legitimately appears in `covered` -- it WAS
       asked about and has no mark, which is the whole distinction that field
       exists to carry. What must not exist is a MARK for it. */
    expect(body.marks.some((m: { athlete_id: string }) => m.athlete_id === 'ath-2')).toBe(false);
    expect(body.covered).toContain('ath-2');
  });

  test('the response names which athletes it covered', async () => {
    mockPrincipal.mockResolvedValue(principal());
    mockAttendance.mockResolvedValue([
      { athlete_id: 'ath-1', status: 'present', source: 'activity_log' },
    ]);

    const body = await (await GET(request())).json();

    /* WITHOUT THIS THE CALLER CANNOT TELL TWO THINGS APART. The workspace
       roster comes from a route that returns every athlete in the
       organization; this one is scoped by the access contract and is
       narrower. An athlete missing from `marks` is either covered-and-
       unmarked or never asked about, and only `covered` distinguishes them --
       the surface rendered both as "no mark yet" until it existed. */
    expect(body.covered).toEqual(['ath-1', 'ath-2']);
    expect(body.marks).toHaveLength(1);
  });

  test('a failed read is a failure, never an empty register', async () => {
    mockPrincipal.mockResolvedValue(principal());
    mockAttendance.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const response = await GET(request());

    /* An empty marks array and a broken query look identical to a caller, and
       one of them means "nobody is here". The route fails instead. */
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.marks).toBeUndefined();
  });

  test('a coach with an empty roster asks the database nothing', async () => {
    mockPrincipal.mockResolvedValue(principal());
    mockCoachRoster.mockResolvedValue([]);

    const body = await (await GET(request())).json();

    expect(body.ok).toBe(true);
    expect(body.marks).toEqual([]);
    // The module short-circuits an empty list; assert the route still asked
    // it rather than inventing the answer itself.
    expect(mockAttendance.mock.calls[0][1]).toEqual([]);
  });
});
