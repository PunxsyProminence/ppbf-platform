import { NextRequest } from 'next/server';

import * as routeModule from './route';
import { GET } from './route';
import { query, queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/**
 * Staff read of an athlete's body mass (elite-boxing item 5).
 *
 * THE RULE UNDER TEST (Jason 2026-10-04): an adult's weight is readable by any
 * coach or organization admin in the athlete's gym; a youth's -- and an
 * athlete with no recorded date of birth -- only by the assigned coach, a
 * coach with a live coverage grant, or the organization admin. Everyone else
 * gets `body_mass: null`, the same answer as "no weigh-in".
 *
 * WHAT IS REAL. requirePrincipal and the database are faked; the route,
 * access.ts (both gates), athleteBodyMass.ts and the MVP-12 formula are the
 * shipped code. The fake answers a predicate only when the SQL carries it --
 * the coach_id, coverage window and deleted_at filters are read out of the
 * statement -- so a youth's weight reaching an unassigned coach is decided by
 * the queries actually issued, not by a stubbed gate told what to say.
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

const NOW = new Date('2026-10-04T18:00:00Z');
const DAY = 24 * 60 * 60 * 1_000;

interface FakeAthlete {
  organization_id: string;
  athlete_id: string;
  coach_id: string;
  dob: string | null;
  deleted_at: string | null;
}

interface FakeCoverage {
  organization_id: string;
  athlete_id: string;
  covering_coach_id: string;
  live: boolean;
}

interface FakeWeighIn {
  organization_id: string;
  athlete_id: string;
  observation_id: string;
  numeric_value: number;
  unit: string;
  observed_at: string;
}

let athletes: FakeAthlete[];
let coverage: FakeCoverage[];
let weighIns: FakeWeighIn[];
let statements: string[];

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function weighInsFor(athleteId: string, prior: number, latest: number): FakeWeighIn[] {
  return [
    {
      organization_id: 'org-1',
      athlete_id: athleteId,
      observation_id: `${athleteId}-prior`,
      numeric_value: prior,
      unit: 'kilograms',
      observed_at: new Date(NOW.getTime() - 8 * DAY).toISOString(),
    },
    {
      organization_id: 'org-1',
      athlete_id: athleteId,
      observation_id: `${athleteId}-latest`,
      numeric_value: latest,
      unit: 'kilograms',
      observed_at: new Date(NOW.getTime() - 1 * DAY).toISOString(),
    },
  ];
}

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(NOW);
  athletes = [
    // 14 years old on NOW.
    { organization_id: 'org-1', athlete_id: 'ath-youth', coach_id: 'coach-record', dob: '2012-03-01', deleted_at: null },
    // 30 years old.
    { organization_id: 'org-1', athlete_id: 'ath-adult', coach_id: 'coach-record', dob: '1996-03-01', deleted_at: null },
    // No date of birth on file: treated as a youth.
    { organization_id: 'org-1', athlete_id: 'ath-no-dob', coach_id: 'coach-record', dob: null, deleted_at: null },
    { organization_id: 'org-1', athlete_id: 'ath-deleted', coach_id: 'coach-record', dob: '1996-03-01', deleted_at: '2026-09-01T00:00:00Z' },
  ];
  coverage = [
    { organization_id: 'org-1', athlete_id: 'ath-youth', covering_coach_id: 'coach-covering', live: true },
    { organization_id: 'org-1', athlete_id: 'ath-youth', covering_coach_id: 'coach-lapsed', live: false },
  ];
  // 60 -> 56.4 kg is -6.0%: past the 5% line.
  weighIns = [
    ...weighInsFor('ath-youth', 60, 56.4),
    ...weighInsFor('ath-adult', 80, 75.2),
    ...weighInsFor('ath-no-dob', 50, 47),
    ...weighInsFor('ath-deleted', 80, 70),
  ];
  statements = [];

  mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = normalize(sql);
    statements.push(text);
    if (/^(insert|update|delete|create|alter|drop)\b/i.test(text)) {
      throw new Error(`write attempted by a read-only route: ${text}`);
    }
    const values = params as string[];

    if (text.includes('from pilot.coach_coverage')) {
      const [organizationId, athleteId, coachId] = values;
      const windowed = text.includes('expires_at > now()');
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

    if (text.includes('from pilot.athletes')) {
      const liveOnly = text.includes('deleted_at is null');
      const live = (row: FakeAthlete) => !liveOnly || row.deleted_at === null;
      if (text.includes('as dob')) {
        // athleteBodyMass's own lookup: organization_id = $1, athlete_id = $2.
        if (!text.includes('organization_id = $1') || !text.includes('athlete_id = $2')) {
          throw new Error(`dob lookup without its scope: ${text}`);
        }
        const [organizationId, athleteId] = values;
        const hit = athletes.find((row) => row.organization_id === organizationId
          && row.athlete_id === athleteId && live(row));
        return hit ? { dob: hit.dob } : null;
      }
      const organizationPredicate = /organization_id = \$(\d+)/.exec(text);
      const organizationId = organizationPredicate ? values[Number(organizationPredicate[1]) - 1] : null;
      const inOrganization = (row: FakeAthlete) => organizationId === null || row.organization_id === organizationId;
      if (text.includes('coach_id = $2')) {
        const [athleteId, coachId] = values;
        const hit = athletes.find((row) => row.athlete_id === athleteId
          && row.coach_id === coachId && inOrganization(row) && live(row));
        return hit ? { athlete_id: hit.athlete_id } : null;
      }
      const [athleteId] = values;
      const hit = athletes.find((row) => row.athlete_id === athleteId && inOrganization(row) && live(row));
      return hit ? { athlete_id: hit.athlete_id } : null;
    }

    throw new Error(`unexpected SQL in this test: ${text}`);
  });

  mockQuery.mockImplementation(async (sql: string, params: unknown[]) => {
    const text = normalize(sql);
    statements.push(text);
    if (!text.includes('from pilot.shadow_formula_observations')) {
      throw new Error(`unexpected list query: ${text}`);
    }
    if (!text.includes("observation_kind = 'body_weight'")) {
      throw new Error(`weight read not limited to body_weight: ${text}`);
    }
    const [organizationId, athleteId, from, to] = params as string[];
    return weighIns
      .filter((row) => row.organization_id === organizationId
        && row.athlete_id === athleteId
        && row.observed_at > from
        && row.observed_at <= to)
      .sort((a, b) => a.observed_at.localeCompare(b.observed_at));
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

async function readAs(caller: Partial<PilotPrincipal>, athleteId = 'ath-youth', extra = '') {
  mockRequirePrincipal.mockResolvedValue(principal(caller));
  const response = await GET(new NextRequest(
    `http://localhost/api/pilot/coach/athlete-body-mass?athlete_id=${athleteId}${extra}`,
  ));
  const payload = (await response.json()) as { body_mass?: Record<string, unknown> | null };
  return { status: response.status, payload };
}

const weightReads = () => statements.filter((sql) => sql.includes('shadow_formula_observations'));

describe('a youth\'s weight reaches only their own coach, a covering coach and the organization admin', () => {
  test.each([
    ['coach of record', { accountId: 'coach-record' }],
    ['coach with a live coverage grant', { accountId: 'coach-covering' }],
    ['organization admin', { accountId: 'acct-admin', role: 'organization_admin' as const }],
    ['legacy admin role', { accountId: 'acct-admin', role: 'admin' as const }],
  ])('%s reads it, with the flag', async (_label, caller) => {
    const { status, payload } = await readAs(caller);

    expect(status).toBe(200);
    expect(payload.body_mass).toMatchObject({
      latest: { kilograms: 56.4 },
      change: { percent: -6, days: 7 },
      flagged: true,
      flag_text: 'Weight down 6.0% in 7 days (132.3 lb → 124.3 lb). Check in with the athlete.',
      threshold_percent: 5,
      window_days: 7,
    });
  });

  test.each([
    ['coach in the gym with no assignment and no coverage', 'coach-unrelated'],
    ['coach whose coverage grant has lapsed', 'coach-lapsed'],
  ])('%s gets null, and the weight is never read', async (_label, accountId) => {
    const { status, payload } = await readAs({ accountId });

    expect(status).toBe(200);
    expect(payload).toEqual({ body_mass: null });
    expect(JSON.stringify(payload)).not.toMatch(/56\.4|124\.3|flag/);
    expect(weightReads()).toEqual([]);
  });

  test('a missing date of birth is treated as a youth', async () => {
    const unrelated = await readAs({ accountId: 'coach-unrelated' }, 'ath-no-dob');
    expect(unrelated.payload).toEqual({ body_mass: null });

    const ownCoach = await readAs({ accountId: 'coach-record' }, 'ath-no-dob');
    expect(ownCoach.payload.body_mass).toMatchObject({ latest: { kilograms: 47 }, flagged: true });
  });

  test('"no weight" and "not yours to see" are the same answer', async () => {
    weighIns = weighIns.filter((row) => row.athlete_id !== 'ath-youth');
    const none = await readAs({ accountId: 'coach-record' });
    weighIns = [...weighIns, ...weighInsFor('ath-youth', 60, 56.4)];
    const hidden = await readAs({ accountId: 'coach-unrelated' });

    expect(none).toEqual(hidden);
  });
});

describe('an adult\'s weight follows the check-in: any coach in the gym', () => {
  test('a coach with no assignment reads it', async () => {
    const { status, payload } = await readAs({ accountId: 'coach-unrelated' }, 'ath-adult');

    expect(status).toBe(200);
    expect(payload.body_mass).toMatchObject({ latest: { kilograms: 75.2 }, change: { percent: -6 }, flagged: true });
  });
});

describe('refusals', () => {
  test('athlete, parent, platform owner, board and others have no path here and nothing is read', async () => {
    for (const role of ['athlete', 'parent', 'platform_owner', 'board', 'staff'] as const) {
      statements = [];
      const { status, payload } = await readAs({ accountId: `acct-${role}`, role, athleteId: 'ath-youth' });
      expect({ role, status }).toEqual({ role, status: 403 });
      expect(payload.body_mass).toBeUndefined();
      expect(statements).toEqual([]);
    }
  });

  test('another gym\'s session is refused, and an organization_id on the query string changes nothing', async () => {
    const { status, payload } = await readAs(
      { accountId: 'acct-admin', role: 'organization_admin', organizationId: 'org-2' },
      'ath-youth',
      '&organization_id=org-1',
    );
    expect(status).toBe(403);
    expect(payload.body_mass).toBeUndefined();
    expect(weightReads()).toEqual([]);
  });

  test('a soft-deleted athlete is refused, to their own coach too', async () => {
    const { status } = await readAs({ accountId: 'coach-record' }, 'ath-deleted');
    expect(status).toBe(403);
    expect(weightReads()).toEqual([]);
  });

  test('no athlete named is a 400', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    const response = await GET(new NextRequest('http://localhost/api/pilot/coach/athlete-body-mass'));
    expect(response.status).toBe(400);
  });
});

describe('read only', () => {
  test('GET is the only handler, and every statement is a select', async () => {
    const handlers = Object.keys(routeModule).filter((name) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(name));
    expect(handlers).toEqual(['GET']);

    await readAs({ accountId: 'coach-record' });
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) expect(sql).toMatch(/^select\b/i);
  });
});
