import { NextRequest } from 'next/server';

import { GET } from './route';
import { athleteIdsForCoach } from '@/src/server/pilot/access';
import { organizationActionableRoster } from '@/src/server/pilot/coachAthleteRoster';
import { getAthletesForCoach } from '@/src/server/pilot/entities';
import { getAthletesByOrganization } from '@/src/server/pilot/entities';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/*
 * The picker behind the sparring log's "which athlete is this for" control.
 *
 * The defect this route exists to close was not a missing check -- the write
 * path's assertActorCanAccessAthlete was correct all along. It was that the
 * only coach-facing roster read, /api/pilot/athletes/list, answers a coach
 * with EVERY athlete in the organization (getAthletesForCoach is a display
 * projection with field redaction, not an access boundary). Built on that, a
 * picker offers a coach athletes the server will refuse.
 *
 * So the assertions below are about which of the two reads decides membership,
 * not merely about the shape of the response.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, athleteIdsForCoach: jest.fn() };
});

jest.mock('@/src/server/pilot/entities', () => ({
  getAthletesForCoach: jest.fn(),
  getAthletesByOrganization: jest.fn(),
}));

jest.mock('@/src/server/pilot/coachAthleteRoster', () => {
  const actual = jest.requireActual('@/src/server/pilot/coachAthleteRoster');
  return { ...actual, organizationActionableRoster: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockCoachIds = athleteIdsForCoach as jest.Mock;
const mockForCoach = getAthletesForCoach as jest.Mock;
const mockByOrg = organizationActionableRoster as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
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

const getRequest = () => new NextRequest('http://localhost/api/pilot/coach/athletes');

test('a coach gets exactly the athletes the access contract grants, not the gym', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  // The display projection knows all three; the access contract grants one.
  mockForCoach.mockResolvedValue([
    { athlete_id: 'ath-1', full_name: 'Rosa Delgado' },
    { athlete_id: 'ath-2', full_name: 'Marcus Webb' },
    { athlete_id: 'ath-3', full_name: 'Dani Ortiz' },
  ]);
  mockCoachIds.mockResolvedValue(['ath-1']);

  const response = await GET(getRequest());
  const payload = await response.json();

  expect(response.status).toBe(200);
  expect(mockCoachIds).toHaveBeenCalledWith('org-1', 'acct-coach-a');
  expect(payload.items).toEqual([{ athlete_id: 'ath-1', full_name: 'Rosa Delgado' }]);
  // The two athletes this coach cannot write for are not offered as options.
  expect(JSON.stringify(payload)).not.toContain('ath-2');
  expect(JSON.stringify(payload)).not.toContain('Marcus Webb');
});

test('active coverage puts a covered athlete on the list', async () => {
  // athleteIdsForCoach is coach-of-record UNION active, unexpired coverage.
  // This route does not re-implement that union and must not: it asks.
  mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-coach-b' }));
  mockForCoach.mockResolvedValue([
    { athlete_id: 'ath-1', full_name: 'Rosa Delgado' },
    { athlete_id: 'ath-2', full_name: 'Marcus Webb' },
  ]);
  mockCoachIds.mockResolvedValue(['ath-2', 'ath-1']);

  const payload = await (await GET(getRequest())).json();

  expect(payload.items.map((item: { athlete_id: string }) => item.athlete_id).sort())
    .toEqual(['ath-1', 'ath-2']);
});

test('expired or revoked coverage takes the athlete off the list', async () => {
  // The same coach as above, after the coverage grant lapsed: the contract
  // stops returning the id, so the option disappears with it.
  mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-coach-b' }));
  mockForCoach.mockResolvedValue([
    { athlete_id: 'ath-1', full_name: 'Rosa Delgado' },
    { athlete_id: 'ath-2', full_name: 'Marcus Webb' },
  ]);
  mockCoachIds.mockResolvedValue(['ath-2']);

  const payload = await (await GET(getRequest())).json();

  expect(payload.items).toEqual([{ athlete_id: 'ath-2', full_name: 'Marcus Webb' }]);
});

test('a coach with no assigned athletes gets an empty list, not the roster', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockForCoach.mockResolvedValue([
    { athlete_id: 'ath-1', full_name: 'Rosa Delgado' },
    { athlete_id: 'ath-2', full_name: 'Marcus Webb' },
  ]);
  mockCoachIds.mockResolvedValue([]);

  const payload = await (await GET(getRequest())).json();

  expect(payload.items).toEqual([]);
});

test('an organization admin reads the organization, through the ACTIONABLE organization read', async () => {
  // Matches what assertActorCanAccessAthlete grants that role
  // (assertAthleteBelongsToOrganization) and what the sibling coach routes
  // already do. No role is broadened here.
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
  mockByOrg.mockResolvedValue([
    { athlete_id: 'ath-1', full_name: 'Rosa Delgado' },
    { athlete_id: 'ath-9', full_name: 'Iris Kane' },
  ]);

  const payload = await (await GET(getRequest())).json();

  expect(mockByOrg).toHaveBeenCalledWith('org-1');
  expect(mockCoachIds).not.toHaveBeenCalled();
  expect(payload.items).toHaveLength(2);
});

test('the organization read is scoped to the principal\'s organization, never a supplied one', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ role: 'admin', organizationId: 'org-mine' }));
  mockByOrg.mockResolvedValue([]);

  await GET(new NextRequest('http://localhost/api/pilot/coach/athletes?organization_id=org-theirs'));

  expect(mockByOrg).toHaveBeenCalledWith('org-mine');
  expect(mockByOrg).not.toHaveBeenCalledWith('org-theirs');
});

test('the coach read is scoped to the principal\'s organization and account, never supplied ones', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-mine', accountId: 'acct-mine' }));
  mockForCoach.mockResolvedValue([]);
  mockCoachIds.mockResolvedValue([]);

  await GET(new NextRequest(
    'http://localhost/api/pilot/coach/athletes?organization_id=org-theirs&coach_account_id=acct-theirs',
  ));

  expect(mockCoachIds).toHaveBeenCalledWith('org-mine', 'acct-mine');
  expect(mockForCoach).toHaveBeenCalledWith('org-mine', 'acct-mine');
});

test.each(['athlete', 'parent', 'board', 'platform_owner', 'staff'] as const)(
  'the %s role is refused',
  async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

    const response = await GET(getRequest());

    expect(response.status).toBe(403);
    expect(mockCoachIds).not.toHaveBeenCalled();
    expect(mockByOrg).not.toHaveBeenCalled();
  },
);

test('nothing but an id and a name leaves this route', async () => {
  // A picker needs two fields. Passing the roster row through would make this
  // a second athlete-record read on a surface that asked for a dropdown.
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockForCoach.mockResolvedValue([{
    athlete_id: 'ath-1',
    full_name: 'Rosa Delgado',
    dob: '2011-04-02',
    emergency_contact: 'Ana Delgado 555-0101',
    gym_status: 'Foundations',
    coach_id: 'acct-coach-a',
  }]);
  mockCoachIds.mockResolvedValue(['ath-1']);

  const body = JSON.stringify(await (await GET(getRequest())).json());

  expect(body).toContain('Rosa Delgado');
  expect(body).not.toContain('2011-04-02');
  expect(body).not.toContain('Ana Delgado');
  expect(body).not.toContain('555-0101');
  expect(body).not.toContain('Foundations');
});


describe('an archived athlete is not offered to anybody', () => {
  /* assertAthleteBelongsToOrganization refuses an athlete whose deleted_at is
     set, so a picker that offers one hands the caller an option whose every
     subsequent read and write is refused -- and the refusal arrives only after
     they have typed a sparring session or a development block in.
     Reported by review on #771; the coach half never had it. */
  test('the admin branch reads the actionable roster, not the unfiltered one', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin' }));
    mockByOrg.mockResolvedValue([]);

    await GET(getRequest());

    expect(mockByOrg).toHaveBeenCalledWith('org-1');
    expect(getAthletesByOrganization).not.toHaveBeenCalled();
  });

  test('the actionable read applies the same deletion predicate as the gate', async () => {
    // Against real SQL rather than a mock: the predicate is the fix.
    const actual = jest.requireActual('@/src/server/pilot/coachAthleteRoster') as {
      organizationActionableRoster: (organizationId: string) => Promise<unknown>;
    };
    const db = jest.requireMock('@/src/server/pilot/db') as { query: jest.Mock };
    db.query.mockResolvedValue([]);

    await actual.organizationActionableRoster('org-1');

    expect(String(db.query.mock.calls[0][0])).toMatch(/deleted_at is null/);
    expect(db.query.mock.calls[0][1]).toEqual(['org-1']);
  });
});
