import { NextRequest } from 'next/server';

import * as routeModule from './route';
import { GET } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/**
 * A-FIN-03R1 -- any coach or admin in the athlete's own organization reads
 * that athlete's wellness check-in.
 *
 * WHAT IS REAL AND WHAT IS FAKED. requirePrincipal is faked (there is no
 * session store here), and so is the database -- by a small in-memory table
 * set below. Everything between them is the shipped code: the route, the real
 * access.ts (requireRole and assertAthleteBelongsToOrganization), the real
 * athleteCheckIns.ts reader, and the real jsonError. So the 403s here are the
 * ones a caller would receive, and "same organization", "cross-organization"
 * and "soft-deleted" are decided by the access query actually issued, not by a
 * stubbed gate told what to answer.
 *
 * COVERAGE IS STILL MODELLED HERE, ONLY TO PROVE IT IS NOT READ. The fake
 * keeps its coach_coverage table and the cases below still cast a covering
 * coach and a coach whose grant has lapsed -- but under this permission both
 * of them read the check-in because they are in the organization, and the
 * statements the route issued are asserted to contain no coach_coverage
 * lookup at all. A route that quietly started consulting coverage again is
 * caught by that assertion; a suite that simply stopped mentioning coverage
 * would not catch it.
 *
 * THE FAKE HONOURS A PREDICATE ONLY WHEN THE SQL CARRIES IT. A deleted athlete
 * is filtered out only if the statement says `deleted_at is null`, and a
 * cross-organization athlete only if it matches organization_id. If someone
 * drops either from assertAthleteBelongsToOrganization, the fake stops
 * filtering and the refusal tests below go red -- which is the point of
 * modelling the tables rather than the answers.
 *
 * The same applies to the day: the stored rows carry one, the fake matches on
 * it, and the clock below stands on the far side of UTC midnight so that the
 * gym's day and the database's day are two different days throughout.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;

interface FakeAthlete {
  organization_id: string;
  athlete_id: string;
  coach_id: string;
  deleted_at: string | null;
}

interface FakeCoverage {
  organization_id: string;
  athlete_id: string;
  covering_coach_id: string;
  /** Inside its starts_at/expires_at window right now. */
  live: boolean;
}

/* THE CLOCK IS FROZEN ON THE FAR SIDE OF UTC MIDNIGHT, for every test here.
   21:30 on a September evening in Punxsutawney is 01:30 the NEXT day in UTC,
   and both database servers run in UTC. So GYM_DAY and UTC_DAY below are
   different days at the one instant this suite lives at.

   That is not decoration for one test: every stored row is dated GYM_DAY, and
   the fake database matches the day the statement asks for. A read that asked
   for the database's own day -- or for any other day -- finds nothing, and
   every green case in this file goes red. The suite can therefore see WHICH
   day the route read, which is the whole point of the gym-day rule it sits
   on top of (src/server/pilot/athleteCheckIns.ts, requireGymDay). */
const GYM_DAY = '2026-09-22';
const UTC_DAY = '2026-09-23';
const EVENING_AT_THE_GYM = new Date('2026-09-23T01:30:00Z');

/** Today's row for Marisol, with every measure answered and a note that
 *  carries punctuation, a newline and trailing space -- "exactly as stored"
 *  has to survive all three. sleep_hours is fractional on purpose: it is a
 *  quantity, and 7.5 is what a 1-5 rating could never hold. */
const MARISOL_TODAY = {
  organization_id: 'org-1',
  check_in_id: 'ci-marisol-today',
  athlete_id: 'ath-marisol',
  checked_in_on: GYM_DAY,
  energy: 4,
  soreness: 2,
  focus: 5,
  sleep_hours: 7.5,
  hydration: 3,
  motivation: 4,
  mental_clarity: 1,
  stress: 5,
  nutrition_compliance: 2,
  note: 'Left knee is "tight" after sparring.\nStill want to work pads. ',
  created_at: '2026-09-22T21:05:00.000Z',
};

/** A bare check-in: the athlete said "I'm here" and skipped every question. */
const DEVON_TODAY = {
  organization_id: 'org-1',
  check_in_id: 'ci-devon-today',
  athlete_id: 'ath-devon',
  checked_in_on: GYM_DAY,
  energy: null,
  soreness: null,
  focus: null,
  sleep_hours: null,
  hydration: null,
  motivation: null,
  mental_clarity: null,
  stress: null,
  nutrition_compliance: null,
  note: '',
  created_at: '2026-09-22T21:10:00.000Z',
};

let athletes: FakeAthlete[];
let coverage: FakeCoverage[];
let checkInsToday: Array<Record<string, unknown>>;
/** Every statement the route caused, in order -- so the tests can say what
 *  was read, in what order, and that nothing was written. */
let statements: string[];

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(EVENING_AT_THE_GYM);
  athletes = [
    { organization_id: 'org-1', athlete_id: 'ath-marisol', coach_id: 'coach-record', deleted_at: null },
    { organization_id: 'org-1', athlete_id: 'ath-devon', coach_id: 'coach-record', deleted_at: null },
    { organization_id: 'org-1', athlete_id: 'ath-rosa', coach_id: 'coach-record', deleted_at: null },
    { organization_id: 'org-1', athlete_id: 'ath-deleted', coach_id: 'coach-record', deleted_at: '2026-09-01T00:00:00Z' },
  ];
  coverage = [
    { organization_id: 'org-1', athlete_id: 'ath-marisol', covering_coach_id: 'coach-covering', live: true },
    { organization_id: 'org-1', athlete_id: 'ath-marisol', covering_coach_id: 'coach-lapsed', live: false },
  ];
  checkInsToday = [
    MARISOL_TODAY,
    DEVON_TODAY,
    // The soft-deleted athlete still HAS a stored row today. That is what
    // makes the soft-delete refusal a real test: there is data to leak.
    { ...MARISOL_TODAY, check_in_id: 'ci-deleted', athlete_id: 'ath-deleted', note: 'deleted athlete note' },
  ];
  statements = [];

  mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = normalize(sql);
    statements.push(text);

    if (/^(insert|update|delete|create|alter|drop)\b/i.test(text)) {
      throw new Error(`write attempted by a read-only route: ${text}`);
    }

    if (text.includes('from pilot.coach_coverage')) {
      const [organizationId, athleteId, coachId] = params as string[];
      const windowed = text.includes('expires_at > now()');
      // The grant table has no deleted_at of its own. Only a statement that
      // joins the athlete and asks for a live one can see the deletion.
      const liveAthleteOnly = text.includes('join pilot.athletes') && text.includes('deleted_at is null');
      const hit = coverage.find((grant) => grant.organization_id === organizationId
        && grant.athlete_id === athleteId
        && grant.covering_coach_id === coachId
        && (!windowed || grant.live)
        && (!liveAthleteOnly || athletes.some((row) => row.organization_id === grant.organization_id
          && row.athlete_id === grant.athlete_id
          && row.deleted_at === null)));
      return hit ? { athlete_id: hit.athlete_id } : null;
    }

    if (text.includes('from pilot.athlete_check_ins')) {
      /* THE DAY HAS TO BE A VALUE THE APPLICATION RESOLVED AND PASSED IN.
         `current_date` is the DATABASE's day, and the database runs in UTC:
         once it is past UTC midnight the gym is still on the previous day
         (from 8pm during daylight time, 7pm during standard time), so a read
         written that way asks about a day the athlete has not reached. The predicate is
         required, and the database's own clock is refused by name.

         The parameter POSITION is read out of the statement rather than
         assumed, so this checks the predicate and not the argument order. */
      const dayPredicate = /checked_in_on = \$(\d+)::date/.exec(text);
      if (!dayPredicate) {
        throw new Error(`check-in read without an application-resolved day: ${text}`);
      }
      if (text.includes('current_date')) {
        throw new Error(`check-in read left the day to the database clock: ${text}`);
      }
      const values = params as string[];
      const [organizationId, athleteId] = values;
      const day = values[Number(dayPredicate[1]) - 1];
      // Matched on the day as well as the athlete. A read aimed at any other
      // day finds nothing here, which is how this suite can tell a right-day
      // read from a wrong-day one.
      return checkInsToday.find((row) => row.organization_id === organizationId
        && row.athlete_id === athleteId
        && row.checked_in_on === day) ?? null;
    }

    if (text.includes('from pilot.athletes')) {
      const liveOnly = text.includes('deleted_at is null');
      /* Both predicates come out of the statement, and the organization one by
         parameter POSITION -- the two lookups that reach here carry it as $2
         and as $3. Taking the argument instead would scope this table by the
         argument list alone: a gate that stopped saying `organization_id = $n`
         while still PASSING the organization would keep filtering here and the
         cross-organization refusals below would stay green against a query
         that no longer restricts anything. Read from the text, that same edit
         lets another gym's athlete match, and those tests go red. */
      const organizationPredicate = /organization_id = \$(\d+)/.exec(text);
      const values = params as string[];
      const organizationId = organizationPredicate ? values[Number(organizationPredicate[1]) - 1] : null;
      const inOrganization = (row: FakeAthlete) =>
        organizationId === null || row.organization_id === organizationId;
      if (text.includes('coach_id = $2')) {
        const [athleteId, coachId] = values;
        const hit = athletes.find((row) => row.athlete_id === athleteId
          && row.coach_id === coachId
          && inOrganization(row)
          && (!liveOnly || row.deleted_at === null));
        return hit ? { athlete_id: hit.athlete_id } : null;
      }
      const [athleteId] = values;
      const hit = athletes.find((row) => row.athlete_id === athleteId
        && inOrganization(row)
        && (!liveOnly || row.deleted_at === null));
      return hit ? { athlete_id: hit.athlete_id } : null;
    }

    throw new Error(`unexpected SQL in this test: ${text}`);
  });

  // This route has no list read. A call here means it grew one.
  mockQuery.mockImplementation(async (sql: string) => {
    statements.push(normalize(sql));
    throw new Error(`unexpected list query: ${normalize(sql)}`);
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'coach-record',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const getRequest = (query = 'athlete_id=ath-marisol') =>
  new NextRequest(`http://localhost/api/pilot/coach/athlete-check-in?${query}`);

function checkInReads(): string[] {
  return statements.filter((sql) => sql.includes('pilot.athlete_check_ins'));
}

async function readAs(caller: Partial<PilotPrincipal>, query?: string) {
  mockRequirePrincipal.mockResolvedValue(principal(caller));
  const response = await GET(getRequest(query));
  const payload = (await response.json()) as Record<string, unknown>;
  return { status: response.status, payload };
}

describe('any coach or admin in the organization reads today\'s check-in', () => {
  test('the coach of record reads it', async () => {
    const { status, payload } = await readAs({ accountId: 'coach-record' });

    expect(status).toBe(200);
    expect(payload).toEqual({ today: MARISOL_TODAY });
  });

  test('a covering coach with an active coverage grant reads it', async () => {
    const { status, payload } = await readAs({ accountId: 'coach-covering' });

    expect(status).toBe(200);
    expect(payload).toEqual({ today: MARISOL_TODAY });
  });

  test('a coach with no assignment and no coverage reads it -- the change A-FIN-03R1 makes', async () => {
    /* THIS IS THE ONE THAT USED TO BE A 403. coach-unrelated is not Marisol's
       coach_id of record and holds no grant on her, and under the old rule
       that was the end of it. The owner's instruction was "any coach or admin
       should be able to read it", so the only question this route now asks is
       whether Marisol is a live athlete in the coach's own gym. */
    const { status, payload } = await readAs({ accountId: 'coach-unrelated' });

    expect(status).toBe(200);
    expect(payload).toEqual({ today: MARISOL_TODAY });
  });

  test('a coach whose coverage grant has lapsed reads it too -- coverage is irrelevant now', async () => {
    /* coach-lapsed's grant on Marisol is outside its window (live: false), so
       the old rule refused them. Under this permission an expired grant is not
       a lesser relationship -- it is simply not consulted -- and this coach
       reads exactly what a coach who never had a grant reads. */
    const { status, payload } = await readAs({ accountId: 'coach-lapsed' });

    expect(status).toBe(200);
    expect(payload).toEqual({ today: MARISOL_TODAY });
  });

  test('an organization admin reads it, under both the current and the legacy role name', async () => {
    for (const role of ['organization_admin', 'admin'] as const) {
      statements = [];
      const { status, payload } = await readAs({ accountId: 'acct-admin', role });

      expect({ role, status }).toEqual({ role, status: 200 });
      expect(payload).toEqual({ today: MARISOL_TODAY });
    }
  });

  test('no wellness read looks at pilot.coach_coverage at all, for any caller', async () => {
    /* The negative the order names. Grants for Marisol exist in the fake --
       one live, one lapsed -- so a coverage lookup would find something to
       find; the point is that the route never asks. Asserted over every
       flavour of caller, because "it stopped querying for the coach of record"
       was already true before this change. */
    expect(coverage.length).toBeGreaterThan(0);

    for (const caller of [
      { accountId: 'coach-record' },
      { accountId: 'coach-covering' },
      { accountId: 'coach-unrelated' },
      { accountId: 'coach-lapsed' },
      { accountId: 'acct-admin', role: 'organization_admin' as const },
    ]) {
      statements = [];
      const { status } = await readAs(caller);

      expect({ caller: caller.accountId, status }).toEqual({ caller: caller.accountId, status: 200 });
      expect({ caller: caller.accountId, coverageLookups: statements.filter((sql) => sql.includes('pilot.coach_coverage')) })
        .toEqual({ caller: caller.accountId, coverageLookups: [] });
    }
  });
});

describe('everyone else is refused, and refused before any check-in is read', () => {
  test('athlete, parent, platform_owner, board and other roles have no path here', async () => {
    // The athlete is asking about THEMSELVES here and is still refused: their
    // own check-in has its own self-only route, and this staff route does not
    // become a second door to it.
    for (const role of ['athlete', 'parent', 'platform_owner', 'board', 'staff', 'volunteer'] as const) {
      statements = [];
      const { status, payload } = await readAs({ accountId: `acct-${role}`, role, athleteId: 'ath-marisol' });

      expect({ role, status }).toEqual({ role, status: 403 });
      expect(payload.today).toBeUndefined();
      expect(statements).toEqual([]);
    }
  });

  test('a cross-organization request fails closed, for a coach and for an admin', async () => {
    // Same account id as Marisol's coach of record, but a session in another
    // gym. The organization comes from the session, so the org-1 athlete is
    // simply not there to find.
    const coach = await readAs({ accountId: 'coach-record', organizationId: 'org-2' });
    expect(coach.status).toBe(403);

    // An organization_id on the query string changes nothing: the route never
    // reads one.
    const admin = await readAs(
      { accountId: 'acct-admin', role: 'organization_admin', organizationId: 'org-2' },
      'athlete_id=ath-marisol&organization_id=org-1',
    );
    expect(admin.status).toBe(403);

    expect(coach.payload.today).toBeUndefined();
    expect(admin.payload.today).toBeUndefined();
    expect(checkInReads()).toHaveLength(0);
  });

  test('a soft-deleted athlete does not expose the stored row, to their coach or to an admin', async () => {
    const coach = await readAs({ accountId: 'coach-record' }, 'athlete_id=ath-deleted');
    const admin = await readAs({ accountId: 'acct-admin', role: 'organization_admin' }, 'athlete_id=ath-deleted');

    expect(coach.status).toBe(403);
    expect(admin.status).toBe(403);
    expect(JSON.stringify(coach.payload)).not.toContain('deleted athlete note');
    expect(JSON.stringify(admin.payload)).not.toContain('deleted athlete note');
    expect(checkInReads()).toHaveLength(0);
  });

  test('a soft-deleted athlete is refused even where a live coverage grant exists, and without reading one', async () => {
    /* Deleting an athlete ends none of their coverage grants, so this one is
       inside its window. It changes nothing either way: the route does not
       look at grants, and the organization check refuses the deleted athlete
       on the one predicate it carries (`deleted_at is null`). Refused on the
       FIRST statement -- the athletes lookup -- and nothing after it. */
    coverage.push({ organization_id: 'org-1', athlete_id: 'ath-deleted', covering_coach_id: 'coach-covering', live: true });

    const covering = await readAs({ accountId: 'coach-covering' }, 'athlete_id=ath-deleted');
    const deletedRequestStatements = [...statements];
    // The same coach, asking about an athlete_id that names nobody at all.
    const unknown = await readAs({ accountId: 'coach-covering' }, 'athlete_id=ath-nobody');

    expect(covering.status).toBe(403);
    expect(covering.payload.today).toBeUndefined();
    expect(JSON.stringify(covering.payload)).not.toContain('deleted athlete note');
    expect(checkInReads()).toHaveLength(0);
    expect(deletedRequestStatements).toHaveLength(1);
    expect(deletedRequestStatements[0]).toContain('from pilot.athletes');
    expect(deletedRequestStatements[0]).toContain('deleted_at is null');
    // And the refusal says nothing that the refusal for an id naming nobody
    // does not: a caller cannot learn from it that this child exists.
    expect(unknown.status).toBe(403);
    expect(covering.payload).toEqual(unknown.payload);
  });

  test('authorization costs exactly one athletes lookup -- the shared helper\'s -- for coach and admin alike', async () => {
    /* One gate, one query, the same one for both roles: the organization
       membership check. Two lookups would mean the route had grown its own
       copy of the live-athlete rule beside the helper's; a lookup carrying a
       coach_id filter would mean the assignment rule had come back. */
    const athleteLookups = () => statements.filter((sql) => sql.includes('from pilot.athletes'));

    for (const caller of [{ accountId: 'coach-unrelated' }, { accountId: 'acct-admin', role: 'organization_admin' as const }]) {
      statements = [];
      await readAs(caller);

      expect({ caller: caller.accountId, lookups: athleteLookups().length }).toEqual({ caller: caller.accountId, lookups: 1 });
      expect(athleteLookups()[0]).toContain('deleted_at is null');
      expect(athleteLookups()[0]).not.toContain('coach_id');
    }
  });

  test('a request with no athlete named is a 400 and reads nothing', async () => {
    const { status } = await readAs({}, '');

    expect(status).toBe(400);
    expect(statements).toEqual([]);
  });
});

describe('what comes back is the stored row, unaltered', () => {
  test('every stored field reads exactly as stored, including sleep hours and the note', async () => {
    const { payload } = await readAs({ accountId: 'coach-record' });
    const today = payload.today as Record<string, unknown>;

    expect(today).toEqual(MARISOL_TODAY);
    expect(today.sleep_hours).toBe(7.5);
    expect(today.note).toBe('Left knee is "tight" after sparring.\nStill want to work pads. ');
  });

  test('skipped questions stay null -- never 0, never a midpoint', async () => {
    const { payload } = await readAs({ accountId: 'coach-record' }, 'athlete_id=ath-devon');

    expect(payload).toEqual({ today: DEVON_TODAY });
  });

  test('no row today is a successful { today: null }, not a refusal and not a failure', async () => {
    const { status, payload } = await readAs({ accountId: 'coach-record' }, 'athlete_id=ath-rosa');

    expect(status).toBe(200);
    expect(payload).toEqual({ today: null });
  });

  test('nothing is derived: the body is the row and only the row', async () => {
    const { payload } = await readAs({ accountId: 'coach-record' });

    // One key. No band, no average, no score, no clearance riding beside it.
    expect(Object.keys(payload)).toEqual(['today']);
    expect(JSON.stringify(payload)).not.toMatch(/GREEN|YELLOW|RED|readiness|average|clearance|score/i);
  });

  test('the read is scoped to the session\'s organization and the requested athlete, after the gate', async () => {
    await readAs({ accountId: 'coach-unrelated' });

    const readIndex = statements.findIndex((sql) => sql.includes('pilot.athlete_check_ins'));
    const gateIndex = statements.findIndex((sql) => sql.includes('from pilot.athletes'));
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(readIndex).toBeGreaterThan(gateIndex);

    const checkInCall = mockQueryOne.mock.calls.find(([sql]) => String(sql).includes('pilot.athlete_check_ins'));
    expect(checkInCall?.[1]).toEqual(['org-1', 'ath-marisol', GYM_DAY]);
  });

  test('an organization_id on the query string never picks the row, even when the caller passes every gate', async () => {
    // athlete_id is unique only WITHIN an organization -- pilot.athletes' key
    // is (organization_id, athlete_id) -- so another gym can hold an athlete
    // with the very same id, and a check-in today under it. The org-1 coach of
    // record passes both gates (they use the session's organization), so
    // this is the success path: only the read's own organization argument
    // stands between that coach and the other gym's row.
    athletes.push({ organization_id: 'org-2', athlete_id: 'ath-marisol', coach_id: 'coach-other-gym', deleted_at: null });
    checkInsToday.push({
      ...MARISOL_TODAY,
      organization_id: 'org-2',
      check_in_id: 'ci-other-gym-today',
      note: 'other gym athlete note',
    });

    const { status, payload } = await readAs(
      { accountId: 'coach-record' },
      'athlete_id=ath-marisol&organization_id=org-2',
    );

    expect(status).toBe(200);
    expect(payload).toEqual({ today: MARISOL_TODAY });
    expect(JSON.stringify(payload)).not.toContain('other gym athlete note');
    const checkInCall = mockQueryOne.mock.calls.find(([sql]) => String(sql).includes('pilot.athlete_check_ins'));
    expect(checkInCall?.[1]).toEqual(['org-1', 'ath-marisol', GYM_DAY]);
  });
});

describe('the day read is the gym\'s day', () => {
  /* WHY THIS ROUTE CARES. It is the coach-facing read, and the day it asks
     for becomes the day the panel prints beside a child's name. Ask for the
     wrong one and a coach reads last night's numbers under today's heading,
     or is told a child who checked in an hour ago did not. */

  test('the read names the gym\'s day, not the database server\'s', async () => {
    const { status, payload } = await readAs({ accountId: 'coach-record' });

    const checkInCall = mockQueryOne.mock.calls.find(([sql]) => String(sql).includes('pilot.athlete_check_ins'));
    // 21:30 at the gym, 01:30 the next day in UTC. Both days are named, so
    // this says which one was asked for AND which one was not.
    expect(checkInCall?.[1]).toEqual(['org-1', 'ath-marisol', GYM_DAY]);
    expect(checkInCall?.[1]).not.toContain(UTC_DAY);
    expect(status).toBe(200);
    expect(payload).toEqual({ today: MARISOL_TODAY });
  });

  test('a row stored under the database\'s day is not today\'s report', async () => {
    /* Rosa's only row is dated the UTC day -- which is what the old write
       path stored for every check-in taken after UTC midnight while the gym
       was still on the previous day, from 8pm in daylight time and 7pm in
       standard time. A read that
       still asked the database for its day would find this row and hand the
       coach an evening report under tomorrow's heading. The honest answer is
       that Rosa has not checked in on the gym day being asked about. */
    checkInsToday.push({
      ...MARISOL_TODAY,
      check_in_id: 'ci-rosa-utc-day',
      athlete_id: 'ath-rosa',
      checked_in_on: UTC_DAY,
      note: 'filed under the database day',
    });

    const { status, payload } = await readAs({ accountId: 'coach-record' }, 'athlete_id=ath-rosa');

    expect(status).toBe(200);
    expect(payload).toEqual({ today: null });
    expect(JSON.stringify(payload)).not.toContain('filed under the database day');
  });
});

describe('read only', () => {
  test('GET is the only handler this route exports', () => {
    const handlers = Object.keys(routeModule).filter((name) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(name));
    expect(handlers).toEqual(['GET']);
  });

  test('a successful read issues no write of any kind', async () => {
    await readAs({ accountId: 'coach-covering' });
    await readAs({ accountId: 'acct-admin', role: 'organization_admin' }, 'athlete_id=ath-rosa');

    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) {
      expect(sql).toMatch(/^select\b/i);
    }
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
