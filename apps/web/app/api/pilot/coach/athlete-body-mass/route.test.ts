import { NextRequest } from 'next/server';

import * as routeModule from './route';
import { GET, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query, queryOne } from '@/src/server/pilot/db';
import { FormulaRepositoryError, saveFormulaObservation } from '@/src/server/pilot/formulas/repository';
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

// The correction's write. The fake keeps the store's own rule (one successor
// per entry, formulas/repository.ts saveFormulaObservation; its tests cover the
// real SQL) and adds the new entry to `weighIns`, so the read after it goes
// through the same summary as any other read.
jest.mock('@/src/server/pilot/formulas/repository', () => {
  const actual = jest.requireActual('@/src/server/pilot/formulas/repository');
  return { ...actual, saveFormulaObservation: jest.fn() };
});
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockSave = saveFormulaObservation as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

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
  supersedes?: string;
  /** Absent means body_weight. */
  kind?: string;
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

    if (text.includes('from pilot.shadow_formula_observations')) {
      // correctBodyMass's lookup of the entry it would replace.
      if (!text.includes('organization_id = $1') || !text.includes('athlete_id = $2')
        || !text.includes("observation_kind = 'body_weight'")) {
        throw new Error(`entry lookup without its scope: ${text}`);
      }
      const [organizationId, athleteId, observationId] = values;
      const hit = weighIns.find((row) => row.organization_id === organizationId
        && row.athlete_id === athleteId && row.observation_id === observationId);
      return hit ? { context_id: `ctx-${hit.observation_id}`, observed_at: hit.observed_at } : null;
    }

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
    // Honoured only when the SQL says it: an entry something supersedes is
    // left out.
    const currentOnly = text.includes('successor.supersedes_observation_id = o.observation_id');
    const weightSuccessorsOnly = text.includes("successor.observation_kind = 'body_weight'");
    return weighIns
      .filter((row) => row.organization_id === organizationId
        && row.athlete_id === athleteId
        && (row.kind ?? 'body_weight') === 'body_weight'
        && (!currentOnly || !weighIns.some((other) => other.organization_id === row.organization_id
          && other.supersedes === row.observation_id
          && (!weightSuccessorsOnly || (other.kind ?? 'body_weight') === 'body_weight')))
        && row.observed_at > from
        && row.observed_at <= to)
      .sort((a, b) => a.observed_at.localeCompare(b.observed_at));
  });
});

beforeEach(() => {
  mockSave.mockImplementation(async (input: {
    organizationId: string; athleteId: string; value: number; unit: string;
    observedAt: string; supersedesObservationId: string;
  }) => {
    if (weighIns.some((row) => row.supersedes === input.supersedesObservationId)) {
      throw new FormulaRepositoryError('SUPERSEDED_OBSERVATION', 'Observation already has a different immutable successor.');
    }
    const saved = {
      organization_id: input.organizationId,
      athlete_id: input.athleteId,
      observation_id: `fix-of-${input.supersedesObservationId}`,
      numeric_value: input.value,
      unit: input.unit,
      observed_at: input.observedAt,
      supersedes: input.supersedesObservationId,
    };
    weighIns.push(saved);
    return { observationId: saved.observation_id };
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
    expect(payload).toEqual({ body_mass: null, can_correct: false });
    expect(JSON.stringify(payload)).not.toMatch(/56\.4|124\.3|flag/);
    expect(weightReads()).toEqual([]);
  });

  test('a missing date of birth is treated as a youth', async () => {
    const unrelated = await readAs({ accountId: 'coach-unrelated' }, 'ath-no-dob');
    expect(unrelated.payload).toEqual({ body_mass: null, can_correct: false });

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

describe('GET is read only', () => {
  test('GET and the correction POST are the only handlers, and every GET statement is a select', async () => {
    const handlers = Object.keys(routeModule).filter((name) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(name));
    expect(handlers).toEqual(['GET', 'POST']);

    await readAs({ accountId: 'coach-record' });
    expect(statements.length).toBeGreaterThan(0);
    for (const sql of statements) expect(sql).toMatch(/^select\b/i);
  });
});

// CORRECTING A WEIGHT (Jason 2026-10-04, "Athlete or their coach"). The coach
// side: only the athlete's assigned or covering coach may correct. The old
// entry stays; the flag is computed from the corrected value.

async function correctAs(
  caller: Partial<PilotPrincipal>,
  fields: Record<string, unknown> = {},
) {
  mockRequirePrincipal.mockResolvedValue(principal(caller));
  const response = await POST(new NextRequest('http://localhost/api/pilot/coach/athlete-body-mass', {
    method: 'POST',
    body: JSON.stringify({
      athlete_id: 'ath-youth',
      observation_id: 'ath-youth-latest',
      body_mass: 131,
      body_mass_unit: 'lb',
      ...fields,
    }),
  }));
  const payload = (await response.json()) as Record<string, unknown>;
  return { status: response.status, payload };
}

describe('correcting a weight: the athlete\'s own coach', () => {
  test.each([
    ['coach of record', 'coach-record'],
    ['coach with a live coverage grant', 'coach-covering'],
  ])('%s corrects it; the flag uses the corrected value and the original stays', async (_label, accountId) => {
    // 56.4 kg read as a 6% drop; the athlete really weighed 131 lb (59.42 kg).
    const before = await readAs({ accountId });
    expect(before.payload).toMatchObject({ body_mass: { flagged: true }, can_correct: true });

    const { status, payload } = await correctAs({ accountId });

    expect(status).toBe(200);
    expect(payload.corrected).toEqual({
      observation_id: 'fix-of-ath-youth-latest',
      supersedes_observation_id: 'ath-youth-latest',
    });
    expect(payload.body_mass).toMatchObject({
      latest: { observation_id: 'fix-of-ath-youth-latest', kilograms: 59.42 },
      flagged: false,
      flag_text: null,
    });
    // Superseded, not deleted, and the correction keeps the original's time.
    const original = weighIns.find((row) => row.observation_id === 'ath-youth-latest');
    const fix = weighIns.find((row) => row.observation_id === 'fix-of-ath-youth-latest');
    expect(original).toMatchObject({ numeric_value: 56.4 });
    expect(fix).toMatchObject({ supersedes: 'ath-youth-latest', observed_at: original!.observed_at });
    expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'body_weight',
      unit: 'kilograms',
      supersedesObservationId: 'ath-youth-latest',
      createdByAccountId: accountId,
      idempotencyKey: 'body-mass-correction:ath-youth-latest',
    }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'update',
      entity_type: 'athlete_body_mass',
      details: { athlete_id: 'ath-youth', supersedes_observation_id: 'ath-youth-latest' },
    }));
    // No weight in the audit row.
    expect(JSON.stringify(mockAudit.mock.calls)).not.toMatch(/56\.4|59\.42|131/);
  });

  test('a later read shows the corrected value, never the superseded one', async () => {
    await correctAs({ accountId: 'coach-record' });
    const { payload } = await readAs({ accountId: 'coach-record' });
    expect(payload.body_mass).toMatchObject({ latest: { kilograms: 59.42 }, flagged: false });
    expect(JSON.stringify(payload)).not.toMatch(/56\.4/);
  });

  test('a correction that is itself a big change still raises the flag', async () => {
    // 60 kg -> 120 lb (54.43 kg) is -9.3%: the flag reads the corrected value, whatever it is.
    const { payload } = await correctAs({ accountId: 'coach-record' }, { body_mass: 120 });
    expect(payload.body_mass).toMatchObject({ latest: { kilograms: 54.43 }, flagged: true });
  });
});

describe('correcting a weight: everyone else is refused and nothing is written', () => {
  test.each([
    ['coach in the gym with no assignment', { accountId: 'coach-unrelated' }, 'ath-youth'],
    ['coach with no assignment, adult athlete', { accountId: 'coach-unrelated' }, 'ath-adult'],
    ['coach whose coverage has lapsed', { accountId: 'coach-lapsed' }, 'ath-youth'],
    ['organization admin', { accountId: 'acct-admin', role: 'organization_admin' as const }, 'ath-youth'],
    ['legacy admin role', { accountId: 'acct-admin', role: 'admin' as const }, 'ath-youth'],
    ['parent', { accountId: 'acct-parent', role: 'parent' as const }, 'ath-youth'],
    ['platform owner', { accountId: 'acct-owner', role: 'platform_owner' as const }, 'ath-youth'],
    ['the athlete (their path is the athlete route)', { accountId: 'acct-ath', role: 'athlete' as const, athleteId: 'ath-youth' }, 'ath-youth'],
    ['another athlete', { accountId: 'acct-other', role: 'athlete' as const, athleteId: 'ath-adult' }, 'ath-youth'],
    ['own coach, from another gym\'s session', { accountId: 'coach-record', organizationId: 'org-2' }, 'ath-youth'],
  ])('%s', async (_label, caller, athleteId) => {
    const { status } = await correctAs(caller, { athlete_id: athleteId, observation_id: `${athleteId}-latest` });
    expect(status).toBe(403);
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
    expect(weighIns.some((row) => row.supersedes)).toBe(false);
  });

  test('the GET does not offer "Correct" to a coach who may only read', async () => {
    const { payload } = await readAs({ accountId: 'coach-unrelated' }, 'ath-adult');
    expect(payload).toMatchObject({ body_mass: { latest: { kilograms: 75.2 } }, can_correct: false });
  });
});

describe('correcting a weight: which entries', () => {
  // The window is 7 days plus MVP-12's day of tolerance: the flag can compare
  // against an entry up to 8 days back, so that entry must be correctable.
  const addEntry = (id: string, kilograms: number, msBeforeNow: number) => weighIns.push({
    organization_id: 'org-1', athlete_id: 'ath-youth', observation_id: id,
    numeric_value: kilograms, unit: 'kilograms', observed_at: new Date(NOW.getTime() - msBeforeNow).toISOString(),
  });

  test('an entry older than 8 days is refused (409) and nothing is written', async () => {
    addEntry('ath-youth-old', 61, 8 * DAY + 60_000);
    const { status, payload } = await correctAs({ accountId: 'coach-record' }, { observation_id: 'ath-youth-old' });
    expect(status).toBe(409);
    expect(payload.code).toBe('BODY_MASS_CORRECTION_WINDOW');
    expect(mockSave).not.toHaveBeenCalled();
  });

  test('the entry the flag compares against, 8 days back, can be corrected, and that clears a flag it caused', async () => {
    // The 60 kg prior was the slip; the athlete weighed 57.
    const { status, payload } = await correctAs({ accountId: 'coach-record' }, {
      observation_id: 'ath-youth-prior', body_mass: 57, body_mass_unit: 'kg',
    });
    expect(status).toBe(200);
    expect(payload.body_mass).toMatchObject({ latest: { kilograms: 56.4 }, flagged: false });
  });

  test('every current entry in the window is listed for correction, newest first, including an out-of-range slip', async () => {
    addEntry('ath-youth-slip', 564, 2 * DAY);
    const { payload } = await readAs({ accountId: 'coach-record' });
    const listed = (payload.body_mass as { correctable_entries: { observation_id: string }[] }).correctable_entries;
    expect(listed.map((entry) => entry.observation_id)).toEqual(['ath-youth-latest', 'ath-youth-slip', 'ath-youth-prior']);
    // The slip is listed but still kept out of the latest weight and the flag.
    expect(payload.body_mass).toMatchObject({ latest: { kilograms: 56.4 } });

    const fixed = await correctAs({ accountId: 'coach-record' }, { observation_id: 'ath-youth-slip', body_mass: 56.4, body_mass_unit: 'kg' });
    expect(fixed.status).toBe(200);
  });

  test('a superseded entry is not listed', async () => {
    await correctAs({ accountId: 'coach-record' });
    const { payload } = await readAs({ accountId: 'coach-record' });
    const listed = (payload.body_mass as { correctable_entries: { observation_id: string }[] }).correctable_entries;
    expect(listed.map((entry) => entry.observation_id)).toEqual(['fix-of-ath-youth-latest', 'ath-youth-prior']);
  });

  test('nothing in the window: no "Correct" offered', async () => {
    weighIns = weighIns.filter((row) => row.athlete_id !== 'ath-youth');
    addEntry('ath-youth-old', 60, 9 * DAY);
    const { payload } = await readAs({ accountId: 'coach-record' });
    expect(payload).toMatchObject({ body_mass: { latest: { kilograms: 60 }, correctable_entries: [] }, can_correct: false });
  });

  test('only a weight replaces a weight: a successor of another kind does not hide it', async () => {
    weighIns.push({
      organization_id: 'org-1', athlete_id: 'ath-youth', observation_id: 'pain-1', numeric_value: 3,
      unit: 'kilograms', observed_at: NOW.toISOString(), supersedes: 'ath-youth-latest', kind: 'pain_report',
    });
    const { payload } = await readAs({ accountId: 'coach-record' });
    expect(payload.body_mass).toMatchObject({ latest: { kilograms: 56.4 }, flagged: true });
  });

  test('an entry already corrected is refused (409); the correction can be corrected instead', async () => {
    expect((await correctAs({ accountId: 'coach-record' })).status).toBe(200);
    const again = await correctAs({ accountId: 'coach-record' }, { body_mass: 132 });
    expect(again.status).toBe(409);
    expect(again.payload.code).toBe('BODY_MASS_ALREADY_CORRECTED');

    const chained = await correctAs({ accountId: 'coach-record' }, {
      observation_id: 'fix-of-ath-youth-latest',
      body_mass: 132,
    });
    expect(chained.status).toBe(200);
    expect(chained.payload.body_mass).toMatchObject({ latest: { kilograms: 59.87 } });
  });

  test('another athlete\'s entry, under this athlete\'s id, is not found and nothing is written', async () => {
    const { status } = await correctAs({ accountId: 'coach-record' }, { observation_id: 'ath-adult-latest' });
    expect(status).toBe(404);
    expect(mockSave).not.toHaveBeenCalled();
  });

  test.each([
    ['no athlete', { athlete_id: undefined }],
    ['no entry', { observation_id: undefined }],
    ['no weight', { body_mass: undefined }],
    ['a weight out of range', { body_mass: 900 }],
    ['an unknown unit', { body_mass_unit: 'stone' }],
  ])('%s is a 400 and nothing is written', async (_label, fields) => {
    const { status } = await correctAs({ accountId: 'coach-record' }, fields);
    expect(status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });
});
