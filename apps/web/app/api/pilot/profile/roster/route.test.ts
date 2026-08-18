import { NextRequest } from 'next/server';

import { GET } from './route';
import { query } from '@/src/server/pilot/db';
import { getAccountProfiles } from '@/src/server/pilot/profileDb';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

// requirePrincipal is faked; the real jsonError and the real access.ts are
// kept, so the role gate under test is the actual gate. profileVisibility and
// profileIdentity are real too -- the portrait decision that would have served
// a withdrawn child's face is the real one, not a stub that could agree with
// the test by accident.
jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/profileDb', () => ({
  getAccountProfiles: jest.fn(),
}));

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetAccountProfiles = getAccountProfiles as jest.Mock;
const mockQuery = query as jest.Mock;

const COACH = 'coach-alvarez@punxsyprominence.org';

interface AthleteFixture {
  readonly organization_id: string;
  readonly athlete_id: string;
  readonly account_id: string | null;
  readonly full_name: string;
  readonly dob: string | null;
  readonly coach_id: string;
  readonly deleted_at: string | null;
}

// Two children on one coach's roster, identical in every respect that decides
// what may be shown -- both minors, both with a released portrait on file, both
// this coach's own. The ONLY difference is that one has withdrawn and been
// soft-deleted. That is deliberate: it means nothing but deleted_at can be
// responsible for a difference in the response.
const ATHLETES: readonly AthleteFixture[] = [
  {
    organization_id: 'org-1',
    athlete_id: 'ATH-ACTIVE',
    account_id: 'acct-active',
    full_name: 'Marisol Vance',
    dob: '2012-03-04',
    coach_id: COACH,
    deleted_at: null,
  },
  {
    organization_id: 'org-1',
    athlete_id: 'ATH-WITHDRAWN',
    account_id: 'acct-withdrawn',
    full_name: 'Devon Pike',
    dob: '2013-09-17',
    coach_id: COACH,
    deleted_at: '2026-06-01T00:00:00.000Z',
  },
];

/**
 * A stand-in for Postgres that actually honours the predicate.
 *
 * A mock that answers with whatever rows the test hands it would assert its own
 * fixture and pass just as happily against a WHERE clause that filters nothing
 * -- which is exactly the bug this file exists to hold closed. So this reads the
 * SQL the route really built and applies the same narrowing the database would:
 * the organization, the coach when the query scopes to one, and the soft-delete
 * exclusion only if the route asked for it. Drop `and a.deleted_at is null` from
 * route.ts and these tests fail.
 */
function answerAthletesQuery(sql: string, params: readonly unknown[]) {
  const excludesSoftDeleted = /and\s+a\.deleted_at\s+is\s+null/i.test(sql);
  const scopedToOneCoach = sql.includes('a.coach_id = $2');

  return ATHLETES.filter((row) => row.organization_id === params[0])
    .filter((row) => (scopedToOneCoach ? row.coach_id === params[1] : true))
    .filter((row) => (excludesSoftDeleted ? row.deleted_at === null : true))
    // The real select list does not carry deleted_at, so neither does this.
    .map((row) => ({
      athlete_id: row.athlete_id,
      account_id: row.account_id,
      full_name: row.full_name,
      dob: row.dob,
      coach_id: row.coach_id,
    }));
}

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: COACH,
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function makeRequest(search = ''): NextRequest {
  return new NextRequest(`http://localhost/api/pilot/profile/roster${search}`, { method: 'GET' });
}

function releasedPortraitProfile(accountId: string) {
  return {
    organizationId: 'org-1',
    accountId,
    nickname: 'Sparks',
    nicknameClearedAt: null,
    corner: 'red',
    program: 'boxing',
    photoBlobPath: `/blob/${accountId}.jpg`,
    photoContentType: 'image/jpeg',
    photoReviewState: 'released',
  };
}

async function rosterItems(search = '') {
  const response = await GET(makeRequest(search));
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    ok: boolean;
    items: Array<Record<string, unknown>>;
  };
  return body.items;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockQuery.mockImplementation(async (sql: string, params: readonly unknown[] = []) =>
    (sql.includes('pilot.athletes') ? answerAthletesQuery(sql, params) : []));
  // Both children have a released portrait on file. If the withdrawn one ever
  // reaches the mapping step, her face is served.
  mockGetAccountProfiles.mockImplementation(async (_organizationId: string, accountIds: string[]) =>
    new Map(accountIds.map((id) => [id, releasedPortraitProfile(id)])));
});

// A withdrawn athlete is soft-deleted, not removed: pilot.athletes keeps the row
// for the retention window so the purge can act on it later. Every read path
// therefore has to exclude it, or the withdrawal never reaches a screen. When
// this route did not, a child whose family had asked to be removed stayed on the
// live coach roster -- full name, date of birth and portrait -- for two years.
describe('a withdrawn athlete leaves the coach roster', () => {
  test('the coach-scoped roster drops the soft-deleted child and keeps the active one', async () => {
    const items = await rosterItems();

    expect(items.map((item) => item.athlete_id)).toEqual(['ATH-ACTIVE']);
  });

  test('the organization-wide roster drops the soft-deleted child too', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin', accountId: 'admin-1' }));

    const items = await rosterItems('?scope=organization');

    expect(items.map((item) => item.athlete_id)).toEqual(['ATH-ACTIVE']);
  });

  // Not just absent from the id list: none of the three things the finding named
  // -- name, date of birth, portrait -- may survive anywhere in the payload.
  test('no name, date of birth or portrait of the withdrawn child is in the response', async () => {
    for (const search of ['', '?scope=organization']) {
      mockRequirePrincipal.mockResolvedValue(
        search === '' ? principal() : principal({ role: 'organization_admin', accountId: 'admin-1' }),
      );

      const items = await rosterItems(search);
      const payload = JSON.stringify(items);

      expect(payload).not.toContain('ATH-WITHDRAWN');
      expect(payload).not.toContain('Devon Pike');
      expect(payload).not.toContain('2013-09-17');
      expect(payload).not.toContain('acct-withdrawn');
      expect(items.some((item) => item.photo_available === true && item.account_id === 'acct-withdrawn'))
        .toBe(false);
    }
  });

  // The active child must still arrive whole. A filter that quietly emptied the
  // roster would satisfy every assertion above and break the gym floor.
  test('the active child still arrives with the portrait a coach is entitled to', async () => {
    const items = await rosterItems();

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      athlete_id: 'ATH-ACTIVE',
      account_id: 'acct-active',
      full_name: 'Marisol Vance',
      is_mine: true,
      // The real decidePortrait ran: a minor's own coach of record is inside the
      // circle, so the photo is served. This is what the withdrawn child was
      // still getting.
      photo_available: true,
    });
    expect(items[0].ring_name).toBe('Sparks');
  });

  test('an athlete deleted_at of null is what keeps a row, not merely being present in the table', async () => {
    const items = await rosterItems();

    expect(items).toHaveLength(1);
    // Sanity-check the harness itself: with the predicate dropped from the SQL,
    // the same fixture yields both children. That is the pre-fix behaviour, and
    // it is why the assertions above are not tautological.
    const unfiltered = answerAthletesQuery(
      `select a.athlete_id from pilot.athletes a where a.organization_id = $1 and a.coach_id = $2`,
      ['org-1', COACH],
    );
    expect(unfiltered.map((row) => row.athlete_id)).toEqual(['ATH-ACTIVE', 'ATH-WITHDRAWN']);
  });
});

describe('the soft-delete exclusion is in the SQL on every branch', () => {
  test('the coach-scoped query asks the database to exclude soft-deleted athletes', async () => {
    await rosterItems();

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('from pilot.athletes');
    expect(sql).toContain('and a.deleted_at is null');
    expect(params).toEqual(['org-1', COACH]);
  });

  test('the organization-wide query asks for it as well', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'organization_admin', accountId: 'admin-1' }));

    await rosterItems('?scope=organization');

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('from pilot.athletes');
    expect(sql).toContain('and a.deleted_at is null');
    expect(params).toEqual(['org-1']);
  });

  // Every read of pilot.athletes this route makes, not just the one that was
  // reported. If a third branch is ever added without the predicate, this fails.
  test('no query this route makes reads pilot.athletes without the predicate', async () => {
    for (const [search, actor] of [
      ['', principal()],
      ['?scope=organization', principal({ role: 'organization_admin', accountId: 'admin-1' })],
    ] as const) {
      mockQuery.mockClear();
      mockRequirePrincipal.mockResolvedValue(actor);

      await rosterItems(search);

      const athleteReads = (mockQuery.mock.calls as Array<[string, unknown[]]>)
        .map(([sql]) => sql)
        .filter((sql) => sql.includes('pilot.athletes'));

      expect(athleteReads.length).toBeGreaterThan(0);
      for (const sql of athleteReads) {
        expect(sql).toMatch(/and\s+a\.deleted_at\s+is\s+null/i);
      }
    }
  });
});

// The finding was explicit that this is about WHICH ROWS a correctly-authorized
// caller sees, and nothing about who may call. These pin the gate as it stands so
// the row filter cannot be mistaken for a change to it.
describe('the role gate is untouched', () => {
  test('a coach, an organization admin and a legacy admin all still reach the roster', async () => {
    for (const actor of [
      principal(),
      principal({ role: 'organization_admin', accountId: 'admin-1' }),
      principal({ role: 'admin', accountId: 'admin-legacy' }),
    ]) {
      mockRequirePrincipal.mockResolvedValue(actor);

      const response = await GET(makeRequest());

      expect(response.status).toBe(200);
    }
  });

  test('a role outside the gate is still refused before any read runs', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: 'parent', accountId: 'parent-1' }));

    const response = await GET(makeRequest());

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
