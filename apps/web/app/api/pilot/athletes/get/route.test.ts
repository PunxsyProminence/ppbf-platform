import { NextRequest } from 'next/server';

import { POST } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { getAthleteById } from '@/src/server/pilot/entities';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

// requirePrincipal is faked; the real access.ts and the real
// getCoachDisplayName (achievements.ts) run over a doubled db, so the gate
// under test is the actual gate and the coach's name comes from the actual
// reader, deletion mark included.
jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/entities', () => ({
  getAthleteById: jest.fn(),
}));

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetAthleteById = getAthleteById as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

const COACH_ID = 'coach-alvarez@punxsyprominence.org';

const ROW = {
  organization_id: 'org-1',
  athlete_id: 'ATH-1',
  full_name: 'Marisol Vance',
  dob: '2010-03-04',
  weight_class: '132',
  gym_status: 'active',
  emergency_contact: 'Rosa Vance 814-555-0110',
  emergency_contact_note: 'Rosa Vance 814-555-0110',
  active_flag: true,
  coach_id: COACH_ID,
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-02T00:00:00.000Z',
  deleted_at: null,
};

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ATH-1',
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function request(athleteId = 'ATH-1'): NextRequest {
  return new NextRequest('http://localhost/api/pilot/athletes/get', {
    method: 'POST',
    body: JSON.stringify({ athlete_id: athleteId }),
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * queryOne answers by statement: the access gate's live-row check gets the
 * athlete, the name reader's account lookup gets the coach's login (or
 * nothing, which is what the reader's own SQL returns for a deleted account).
 */
function dbWithCoach(loginEmail: string | null) {
  mockQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('login_email')) {
      return loginEmail === null ? null : { login_email: loginEmail };
    }
    return { athlete_id: 'ATH-1' };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue([]);
  mockGetAthleteById.mockResolvedValue(ROW);
  dbWithCoach('alvarez@punxsyprominence.org');
});

describe('POST /api/pilot/athletes/get', () => {
  test('an athlete reading their own record gets the family shape: coach_name, no staff account id', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const res = await POST(request());
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      found: true,
      athlete: {
        athlete_id: 'ATH-1',
        full_name: 'Marisol Vance',
        dob: '2010-03-04',
        weight_class: '132',
        gym_status: 'active',
        emergency_contact: 'Rosa Vance 814-555-0110',
        active_flag: true,
        coach_name: 'Coach Alvarez',
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-02T00:00:00.000Z',
      },
    });
    // The whole body, not one key.
    expect(text).not.toContain(COACH_ID);
    expect(text).not.toContain('coach_id');
  });

  test('a deleted coach is shown to the athlete as the neutral phrase, never the id', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    dbWithCoach(null);

    const res = await POST(request());
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text).athlete.coach_name).toBe('Your coach');
    expect(text).not.toContain(COACH_ID);
    // The reader's own SQL is what excludes the deleted account.
    const nameLookup = mockQueryOne.mock.calls.find(([sql]) => String(sql).includes('login_email'));
    expect(nameLookup?.[0]).toContain('deleted_at is not null');
    expect(nameLookup?.[1]).toEqual(['org-1', COACH_ID]);
  });

  test('a coach gets the row exactly as read, byte for byte', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'coach', accountId: COACH_ID, athleteId: null }));

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ found: true, athlete: ROW }));
    expect(mockQueryOne.mock.calls.some(([sql]) => String(sql).includes('login_email'))).toBe(false);
  });

  test('an organization admin gets the row exactly as read, byte for byte', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin', accountId: 'admin-1', athleteId: null }));

    const res = await POST(request());

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(JSON.stringify({ found: true, athlete: ROW }));
  });

  test("an athlete asking for another athlete's record is refused before the row is read", async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const res = await POST(request('ATH-OTHER'));

    expect(res.status).toBe(403);
    expect(mockGetAthleteById).not.toHaveBeenCalled();
  });

  test('a missing row is reported as not found with nothing else attached', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetAthleteById.mockResolvedValue(null);

    const res = await POST(request());

    expect(await res.text()).toBe(JSON.stringify({ found: false }));
  });

  test('a parent is outside the gate', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent', athleteId: null }));

    const res = await POST(request());

    expect(res.status).toBe(403);
    expect(mockGetAthleteById).not.toHaveBeenCalled();
  });
});
