import { NextRequest } from 'next/server';

import { GET } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { getAttendanceLast28Days } from '@/src/server/pilot/attendancePrecedence';
import { requirePrincipal } from '@/src/server/pilot/http';

/*
 * The coach's attendance read for one athlete (OD-2026-10-17-026 (c), coaches only). The figures
 * themselves are proven against the real view in attendancePrecedence.pg.test.ts; this file
 * asserts who reaches the read and what it hands down.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn(async () => undefined) };
});
jest.mock('@/src/server/pilot/attendancePrecedence', () => ({ getAttendanceLast28Days: jest.fn() }));

const mockPrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockAttendance = getAttendanceLast28Days as jest.Mock;

const COACH = { accountId: 'acct-coach', role: 'coach', organizationId: 'org-1', athleteId: null, sessionToken: 't', authProvider: 'microsoft' };
const WINDOW = {
  athlete_id: 'ath-1', window_from: '2026-09-20', window_to: '2026-10-17', days_present: 3, days_absent: 1,
  days_excused: 0, attendance_rate: 0.75, last_present_day: '2026-10-15', days_since_last_present: 2,
};

function get(query: string) {
  return new NextRequest(`http://localhost/api/pilot/coach/athlete-attendance${query}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPrincipal.mockResolvedValue(COACH);
  mockAttendance.mockResolvedValue(new Map([['ath-1', WINDOW]]));
});

test.each(['athlete', 'parent', 'board', 'volunteer', 'platform_owner', 'staff'])('a %s session is refused before anything is read', async (role) => {
  mockPrincipal.mockResolvedValue({ ...COACH, role });
  expect((await GET(get('?athlete_id=ath-1'))).status).toBe(403);
  expect(mockAccess).not.toHaveBeenCalled();
  expect(mockAttendance).not.toHaveBeenCalled();
});

test.each(['coach', 'organization_admin', 'admin'])('a %s reads the picked athlete through the athlete chokepoint', async (role) => {
  mockPrincipal.mockResolvedValue({ ...COACH, role });
  const response = await GET(get('?athlete_id=ath-1'));
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ role, accountId: 'acct-coach' }), 'ath-1');
  expect(mockAttendance).toHaveBeenCalledWith('org-1', ['ath-1'], expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  expect(await response.json()).toEqual({ ok: true, attendance: WINDOW });
});

test('an athlete the chokepoint refuses is a 403 and nothing is read', async () => {
  mockAccess.mockRejectedValueOnce(new Error('Forbidden: athlete does not belong to organization'));
  expect((await GET(get('?athlete_id=ath-9'))).status).toBe(403);
  expect(mockAttendance).not.toHaveBeenCalled();
});

test('no athlete id is a 400', async () => {
  expect((await GET(get(''))).status).toBe(400);
  expect(mockAttendance).not.toHaveBeenCalled();
});
