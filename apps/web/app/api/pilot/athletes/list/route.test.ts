import { NextRequest } from 'next/server';

import { GET } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { getAthleteById, getAthletesByOrganization, getAthletesForCoach } from '@/src/server/pilot/entities';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

// requirePrincipal is faked; the real jsonError and the real access.ts are
// kept, so the role gate under test is the actual gate and the status codes
// come from the actual prefix mapping rather than from a stub of it.
jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/entities', () => ({
  getAthleteById: jest.fn(),
  getAthletesByOrganization: jest.fn(),
  getAthletesForCoach: jest.fn(),
}));

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetAthleteById = getAthleteById as jest.Mock;
const mockGetAthletesByOrganization = getAthletesByOrganization as jest.Mock;
const mockGetAthletesForCoach = getAthletesForCoach as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

const COACH_ID = 'coach-alvarez@punxsyprominence.org';

// The storage row as `select *` returns it to the athlete and parent
// branches: the contract fields plus the columns the migrations added later.
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

const FAMILY_ITEM = {
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
};

/**
 * queryOne answers by statement: the athlete branch's live-row check gets the
 * athlete; the real getCoachDisplayName's account lookup gets the coach's
 * login, or nothing, which is what its own SQL returns for a deleted account.
 */
function dbWithCoach(loginEmail: string | null) {
  mockQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes('login_email')) {
      return loginEmail === null ? null : { login_email: loginEmail };
    }
    return { athlete_id: 'ATH-1' };
  });
}

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-alvarez@punxsyprominence.org',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  };
}

function makeRequest(): NextRequest {
  return new NextRequest('http://localhost/api/pilot/athletes/list', { method: 'GET' });
}

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks keeps implementations; dbWithCoach's must not leak from
  // one case into the next.
  mockQueryOne.mockReset();
  mockGetAthletesByOrganization.mockResolvedValue([]);
  mockGetAthletesForCoach.mockResolvedValue([]);
  mockGetAthleteById.mockResolvedValue(null);
  mockQuery.mockResolvedValue([]);
});

describe('which read a role gets', () => {
  // The whole point of the field split. A coach reading the roster must go
  // through the relationship-scoped read; if this route ever falls back to
  // getAthletesByOrganization for a coach, every coach in the organization is
  // handed every child's date of birth and guardian phone number again, and
  // nothing errors while it happens.
  test('a coach reads through getAthletesForCoach, never the org-wide read', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    expect(mockGetAthletesForCoach).toHaveBeenCalledWith('org-1', 'coach-alvarez@punxsyprominence.org');
    expect(mockGetAthletesByOrganization).not.toHaveBeenCalled();
  });

  test('the coach read is scoped to the principal, not to anything the caller sends', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-9', accountId: 'coach-9' }));

    await GET(makeRequest());

    expect(mockGetAthletesForCoach).toHaveBeenCalledWith('org-9', 'coach-9');
  });

  test('an organization admin still reads the full row org-wide', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin', accountId: 'admin-1' }));

    const response = await GET(makeRequest());

    expect(response.status).toBe(200);
    // No limit param on the request -- the org-wide roster stays unbounded
    // by default, exactly today's behavior. A caller that wants a bounded
    // page opts in with ?limit=.
    expect(mockGetAthletesByOrganization).toHaveBeenCalledWith('org-1', undefined);
    expect(mockGetAthletesForCoach).not.toHaveBeenCalled();
  });

  // roleEquals aliases the legacy 'admin' row onto organization_admin, so the
  // narrowing must not catch it by accident and quietly cut an admin's roster
  // down to the athletes they happen to be coach_id of.
  test('a legacy admin row reads as an organization admin, not as a coach', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'admin', accountId: 'admin-legacy' }));

    await GET(makeRequest());

    expect(mockGetAthletesByOrganization).toHaveBeenCalledWith('org-1', undefined);
    expect(mockGetAthletesForCoach).not.toHaveBeenCalled();
  });

  test('an explicit limit is passed through as a bounded page', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin', accountId: 'admin-1' }));

    const req = new NextRequest('http://localhost/api/pilot/athletes/list?limit=50&offset=100');
    await GET(req);

    expect(mockGetAthletesByOrganization).toHaveBeenCalledWith('org-1', { limit: 50, offset: 100 });
  });

  test('an invalid limit is rejected with 400, never reaches the roster query', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin', accountId: 'admin-1' }));

    const req = new NextRequest('http://localhost/api/pilot/athletes/list?limit=-5');
    const res = await GET(req);

    expect(res.status).toBe(400);
    expect(mockGetAthletesByOrganization).not.toHaveBeenCalled();
  });

  test('an athlete still gets only their own record', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', athleteId: 'ATH-1' }));
    dbWithCoach('alvarez@punxsyprominence.org');
    mockGetAthleteById.mockResolvedValue(ROW);

    const response = await GET(makeRequest());

    expect(await response.json()).toEqual({ items: [FAMILY_ITEM] });
    expect(mockGetAthleteById).toHaveBeenCalledWith('org-1', 'ATH-1');
    expect(mockGetAthletesForCoach).not.toHaveBeenCalled();
    expect(mockGetAthletesByOrganization).not.toHaveBeenCalled();
  });

  test("a deleted athlete's surviving session is refused before their row is read", async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', athleteId: 'ATH-1' }));
    mockQueryOne.mockResolvedValue(null); // no live row: deleted_at is set
    mockGetAthleteById.mockResolvedValue({ athlete_id: 'ATH-1' });

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden: athlete does not belong to organization' });
    expect(mockQueryOne.mock.calls[0][1]).toEqual(['ATH-1', 'org-1']);
    expect(mockGetAthleteById).not.toHaveBeenCalled();
  });

  test('a parent still resolves children through guardian_links', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent', accountId: 'parent-1' }));
    dbWithCoach('alvarez@punxsyprominence.org');
    mockQuery.mockResolvedValue([ROW]);

    const response = await GET(makeRequest());

    expect(await response.json()).toEqual({ items: [FAMILY_ITEM] });
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('pilot.guardian_links'), ['org-1', 'parent-1']);
    expect(mockGetAthletesForCoach).not.toHaveBeenCalled();
  });

  test('a role outside the gate is refused before any read runs', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'platform_owner' }));

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
    expect(mockGetAthletesForCoach).not.toHaveBeenCalled();
    expect(mockGetAthletesByOrganization).not.toHaveBeenCalled();
  });
});

/*
 * OD-2026-10-06-025 ruling 2: a family sees the coach's display name, never
 * the internal account id. The athlete and parent branches both read
 * `select *`, so the projection is what stands between the row and the
 * family's browser; these cases watch the WHOLE serialised body.
 */
describe('what a family receives', () => {
  test.each([
    ['athlete', principal({ role: 'athlete', athleteId: 'ATH-1' })],
    ['parent', principal({ role: 'parent', accountId: 'parent-1' })],
  ])('%s: no staff account id anywhere in the body, coach_name in its place', async (_role, who) => {
    mockRequirePrincipal.mockResolvedValue(who);
    dbWithCoach('alvarez@punxsyprominence.org');
    mockGetAthleteById.mockResolvedValue(ROW);
    mockQuery.mockResolvedValue([ROW, { ...ROW, athlete_id: 'ATH-2', full_name: 'Teo Vance' }]);

    const response = await GET(makeRequest());
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain(COACH_ID);
    expect(text).not.toContain('coach_id');
    const body = JSON.parse(text) as { items: Array<Record<string, unknown>> };
    expect(body.items.length).toBeGreaterThan(0);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(Object.keys(FAMILY_ITEM).sort());
      expect(item.coach_name).toBe('Coach Alvarez');
    }
    // The name came from the tenancy-scoped reader, asked in this gym.
    const nameLookup = mockQueryOne.mock.calls.find(([sql]) => String(sql).includes('login_email'));
    expect(nameLookup?.[1]).toEqual(['org-1', COACH_ID]);
  });

  test.each([
    ['athlete', principal({ role: 'athlete', athleteId: 'ATH-1' })],
    ['parent', principal({ role: 'parent', accountId: 'parent-1' })],
  ])('%s: a deleted coach shows the neutral phrase, never the id', async (_role, who) => {
    mockRequirePrincipal.mockResolvedValue(who);
    dbWithCoach(null); // the reader's SQL excludes a deleted account
    mockGetAthleteById.mockResolvedValue(ROW);
    mockQuery.mockResolvedValue([ROW]);

    const response = await GET(makeRequest());
    const text = await response.text();

    expect(JSON.parse(text).items[0].coach_name).toBe('Your coach');
    expect(text).not.toContain(COACH_ID);
    const nameLookup = mockQueryOne.mock.calls.find(([sql]) => String(sql).includes('login_email'));
    expect(nameLookup?.[0]).toContain('deleted_at is not null');
  });

  test('a parent with two children of two coaches gets each coach named, one lookup per coach', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent', accountId: 'parent-1' }));
    mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
      if (!sql.includes('login_email')) return { athlete_id: 'ATH-1' };
      return { login_email: params[1] === COACH_ID ? 'alvarez@punxsyprominence.org' : 'pike@punxsyprominence.org' };
    });
    mockQuery.mockResolvedValue([
      ROW,
      { ...ROW, athlete_id: 'ATH-2', full_name: 'Teo Vance', coach_id: 'coach-pike@punxsyprominence.org' },
      { ...ROW, athlete_id: 'ATH-3', full_name: 'Ana Vance' },
    ]);

    const body = (await (await GET(makeRequest())).json()) as { items: Array<{ coach_name: string }> };

    expect(body.items.map((item) => item.coach_name)).toEqual(['Coach Alvarez', 'Coach Pike', 'Coach Alvarez']);
    expect(mockQueryOne.mock.calls.filter(([sql]) => String(sql).includes('login_email'))).toHaveLength(2);
  });

  test('an athlete with no live row gets an empty list and no name lookup', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'athlete', athleteId: 'ATH-1' }));
    dbWithCoach('alvarez@punxsyprominence.org');
    mockGetAthleteById.mockResolvedValue(null);

    expect(await (await GET(makeRequest())).text()).toBe(JSON.stringify({ items: [] }));
    expect(mockQueryOne.mock.calls.some(([sql]) => String(sql).includes('login_email'))).toBe(false);
  });
});

describe('what staff receive is unchanged', () => {
  test('a coach gets the scoped roster exactly as read, byte for byte', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    const roster = [{ ...ROW, dob: null, emergency_contact: null }];
    mockGetAthletesForCoach.mockResolvedValue(roster);

    const response = await GET(makeRequest());

    expect(await response.text()).toBe(JSON.stringify({ items: roster }));
    expect(mockQueryOne).not.toHaveBeenCalled();
  });

  test('an organization admin gets the org-wide rows exactly as read, byte for byte', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin', accountId: 'admin-1' }));
    mockGetAthletesByOrganization.mockResolvedValue([ROW]);

    const response = await GET(makeRequest());

    expect(await response.text()).toBe(JSON.stringify({ items: [ROW] }));
    expect(mockQueryOne).not.toHaveBeenCalled();
  });
});

describe('what the coach branch hands back', () => {
  // The route is a pass-through: it must not re-add the columns the scoped
  // read redacted, and it must not drop the keys either.
  test('redacted rows reach the client with the keys present and null', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetAthletesForCoach.mockResolvedValue([
      {
        athlete_id: 'ATH-MINE',
        full_name: 'Marisol Vance',
        dob: '2010-03-04',
        weight_class: '132',
        gym_status: 'active',
        emergency_contact: 'Rosa Vance 814-555-0110',
        active_flag: true,
        coach_id: 'coach-alvarez@punxsyprominence.org',
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z',
      },
      {
        athlete_id: 'ATH-THEIRS',
        full_name: 'Devon Pike',
        dob: null,
        weight_class: '145',
        gym_status: 'active',
        emergency_contact: null,
        active_flag: true,
        coach_id: 'coach-other@punxsyprominence.org',
        created_at: '2026-08-02T00:00:00.000Z',
        updated_at: '2026-08-02T00:00:00.000Z',
      },
    ]);

    const body = (await (await GET(makeRequest())).json()) as {
      items: Array<Record<string, unknown>>;
    };

    expect(body.items).toHaveLength(2);
    expect(body.items[1]).toHaveProperty('dob', null);
    expect(body.items[1]).toHaveProperty('emergency_contact', null);
    // Still a whole roster: the athlete this coach does not coach is present
    // and nameable, which is the half of the split that keeps cover working.
    expect(body.items[1].full_name).toBe('Devon Pike');
    expect(body.items[1].gym_status).toBe('active');
  });
});

/* Dates of birth pinned to the GYM's calendar day, the way the rule reads
   them (wallDisplay.isMinor via guardianAccess.guardianLinkEnded): one athlete
   turned 18 today at the gym, the other turns 18 tomorrow and is a minor
   until local midnight. */
const gymYmd = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
const minus18 = (ymd: string) => `${Number(ymd.slice(0, 4)) - 18}${ymd.slice(4)}`;
const ADULT_DOB = minus18(gymYmd(new Date()));
const MINOR_DOB = minus18(gymYmd(new Date(Date.now() + 24 * 60 * 60 * 1000)));

describe('the guardian link goes dormant at 18 (OD-2026-10-07-008)', () => {
  test('a parent no longer sees the child who turned 18 today; the minor stays', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent', accountId: 'parent-1' }));
    dbWithCoach('alvarez@punxsyprominence.org');
    mockQuery.mockResolvedValue([
      { ...ROW, athlete_id: 'ATH-ADULT', full_name: 'Adult Vance', dob: ADULT_DOB },
      { ...ROW, athlete_id: 'ATH-TOMORROW', full_name: 'Tomorrow Vance', dob: MINOR_DOB },
      ROW,
    ]);

    const response = await GET(makeRequest());
    const body = (await response.json()) as { items: Array<{ athlete_id: string }> };

    expect(body.items.map((item) => item.athlete_id)).toEqual(['ATH-TOMORROW', 'ATH-1']);
    expect(JSON.stringify(body)).not.toContain('Adult Vance');
  });
});
