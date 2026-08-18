import { NextRequest } from 'next/server';

import { GET } from './route';
import { query } from '@/src/server/pilot/db';
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
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetAthleteById = getAthleteById as jest.Mock;
const mockGetAthletesByOrganization = getAthletesByOrganization as jest.Mock;
const mockGetAthletesForCoach = getAthletesForCoach as jest.Mock;
const mockQuery = query as jest.Mock;

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
    mockGetAthleteById.mockResolvedValue({ athlete_id: 'ATH-1' });

    const response = await GET(makeRequest());

    expect(await response.json()).toEqual({ items: [{ athlete_id: 'ATH-1' }] });
    expect(mockGetAthletesForCoach).not.toHaveBeenCalled();
    expect(mockGetAthletesByOrganization).not.toHaveBeenCalled();
  });

  test('a parent still resolves children through guardian_links', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent', accountId: 'parent-1' }));
    mockQuery.mockResolvedValue([{ athlete_id: 'ATH-KID' }]);

    const response = await GET(makeRequest());

    expect(await response.json()).toEqual({ items: [{ athlete_id: 'ATH-KID' }] });
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
