import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { queryOne } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  getSparringExposureCounts,
  listActiveUniversalStopRules,
  listSparringExposure,
  recordSparringExposure,
} from '@/src/server/pilot/sparringExposure';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

/**
 * Coach floor entry for sparring exposure.
 *
 * WHAT IS REAL AND WHAT IS FAKED. requirePrincipal is faked (no session store)
 * and so is the driver. The route, the real access.ts (requireRole,
 * assertActorCanAccessAthlete, assertAthleteBelongsToOrganization) and the
 * real jsonError run as shipped, so a 403 here is the one a caller gets. The
 * sparringExposure module is mocked: its SQL is proven against real Postgres
 * in sparringExposure.pg.test.ts and sparringExposureSessionDate.pg.test.ts.
 *
 * THE FAKE HONOURS A PREDICATE ONLY WHEN THE SQL CARRIES IT. A deleted athlete
 * is filtered only because the statement says `deleted_at is null`, a coverage
 * grant only counts inside its window because the statement asks for it, and
 * a cross-organization athlete fails only because organization_id is matched.
 */

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
}));

jest.mock('@/src/server/pilot/sparringExposure', () => ({
  recordSparringExposure: jest.fn(),
  listSparringExposure: jest.fn(),
  getSparringExposureCounts: jest.fn(),
  listActiveUniversalStopRules: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockRecord = recordSparringExposure as jest.Mock;
const mockList = listSparringExposure as jest.Mock;
const mockCounts = getSparringExposureCounts as jest.Mock;
const mockStopRules = listActiveUniversalStopRules as jest.Mock;

const ORG = 'org-gym';
const OTHER_ORG = 'org-elsewhere';

/* 20:30 in Punxsutawney is 00:30 the next day in UTC: the gym day and the UTC
   day differ at this instant, so a route that used the UTC day is caught. */
const EVENING_AT_THE_GYM = new Date('2026-10-04T00:30:00Z');
const GYM_DAY = '2026-10-03';

interface FakeAthlete { organization_id: string; athlete_id: string; coach_id: string; deleted_at: string | null }
interface FakeCoverage { organization_id: string; athlete_id: string; covering_coach_id: string; live: boolean }

let athletes: FakeAthlete[];
let coverage: FakeCoverage[];

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

function fakeQueryOne(sql: string, params: unknown[]) {
  const text = normalize(sql);
  const live = (athlete: FakeAthlete) => !text.includes('deleted_at is null') || athlete.deleted_at === null;

  if (text.startsWith('select athlete_id from pilot.athletes where athlete_id = $1 and coach_id = $2 and organization_id = $3')) {
    const [athleteId, coachId, orgId] = params as string[];
    const hit = athletes.find((a) => a.athlete_id === athleteId && a.coach_id === coachId && a.organization_id === orgId && live(a));
    return hit ? { athlete_id: hit.athlete_id } : null;
  }
  if (text.startsWith('select athlete_id from pilot.athletes where athlete_id = $1 and organization_id = $2')) {
    const [athleteId, orgId] = params as string[];
    const hit = athletes.find((a) => a.athlete_id === athleteId && a.organization_id === orgId && live(a));
    return hit ? { athlete_id: hit.athlete_id } : null;
  }
  if (text.startsWith('select cc.athlete_id from pilot.coach_coverage cc')) {
    const [orgId, athleteId, coachId] = params as string[];
    const windowed = text.includes('cc.starts_at <= now()') && text.includes('cc.expires_at > now()');
    const hit = coverage.find((grant) => {
      const athlete = athletes.find((a) => a.organization_id === grant.organization_id && a.athlete_id === grant.athlete_id);
      return grant.organization_id === orgId && grant.athlete_id === athleteId && grant.covering_coach_id === coachId
        && (!windowed || grant.live) && athlete !== undefined && live(athlete);
    });
    return hit ? { athlete_id: hit.athlete_id } : null;
  }
  throw new Error(`fake db: unmodelled statement: ${text}`);
}

function principal(role: PilotPrincipal['role'], accountId: string, organizationId = ORG): PilotPrincipal {
  return { accountId, role, organizationId, athleteId: role === 'athlete' ? 'ath-kid' : null, sessionToken: 't', authProvider: 'ppbf_local' };
}

const COACH_OF_RECORD = principal('coach', 'coach-record');
const COVERING_COACH = principal('coach', 'coach-cover');
const LAPSED_COACH = principal('coach', 'coach-lapsed');
const UNRELATED_COACH = principal('coach', 'coach-unrelated');
const ORG_ADMIN = principal('organization_admin', 'admin-org');
const LEGACY_ADMIN = principal('admin', 'admin-legacy');
const OTHER_GYM_ADMIN = principal('organization_admin', 'admin-other', OTHER_ORG);

function getRequest(query: string) {
  return new NextRequest(`http://localhost/api/pilot/coach/sparring-exposure?${query}`);
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/pilot/coach/sparring-exposure', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const VALID_BODY = {
  athlete_id: 'ath-kid',
  sparring_type: 'technical',
  time_under_impact_sec: 75,
  round_equivalent: 2,
  headgear_worn: true,
  glove_oz: 16,
  coach_observed_intensity: 'light',
  coach_observed_head_contact: 'incidental',
  athlete_presentation: 'normal',
  coach_note: '  Kept his hands up.  ',
};

beforeEach(() => {
  jest.useFakeTimers({ now: EVENING_AT_THE_GYM, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
  jest.clearAllMocks();
  athletes = [
    { organization_id: ORG, athlete_id: 'ath-kid', coach_id: 'coach-record', deleted_at: null },
    { organization_id: ORG, athlete_id: 'ath-partner', coach_id: 'coach-unrelated', deleted_at: null },
    { organization_id: ORG, athlete_id: 'ath-gone', coach_id: 'coach-record', deleted_at: '2026-09-30T00:00:00Z' },
    { organization_id: OTHER_ORG, athlete_id: 'ath-away', coach_id: 'coach-record', deleted_at: null },
  ];
  coverage = [
    { organization_id: ORG, athlete_id: 'ath-kid', covering_coach_id: 'coach-cover', live: true },
    { organization_id: ORG, athlete_id: 'ath-kid', covering_coach_id: 'coach-lapsed', live: false },
    { organization_id: ORG, athlete_id: 'ath-gone', covering_coach_id: 'coach-cover', live: true },
  ];
  mockQueryOne.mockImplementation(async (sql: string, params: unknown[]) => fakeQueryOne(sql, params));
  mockList.mockResolvedValue([{ exposure_id: 'e1' }]);
  mockCounts.mockResolvedValue({
    total_segments: 1,
    total_time_under_impact_sec: 75,
    segments_by_type: { hard: 0, play: 0, technical: 1, game: 0, conditioned: 0 },
  });
  mockStopRules.mockResolvedValue([
    { universal_rule_id: 'ust_bleeding', ordinal: 1, condition_text: 'Bleeding', rule_kind: 'safety' },
  ]);
  mockRecord.mockImplementation(async (input: Record<string, unknown>) => ({ exposure_id: 'new', ...input }));
});

afterEach(() => {
  jest.useRealTimers();
});

describe('GET /api/pilot/coach/sparring-exposure', () => {
  test.each([
    ['coach of record', COACH_OF_RECORD],
    ['coach with a live coverage grant', COVERING_COACH],
    ['organization admin', ORG_ADMIN],
    ['legacy admin', LEGACY_ADMIN],
  ])('%s reads entries, raw counts and the gym\'s stop rules', async (_label, who) => {
    mockRequirePrincipal.mockResolvedValue(who);
    const response = await GET(getRequest('athlete_id=ath-kid'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['counts', 'entries', 'stop_rules', 'window_days']);
    expect(body.window_days).toBe(28);
    const since = new Date(EVENING_AT_THE_GYM.getTime() - 28 * 86_400_000).toISOString();
    expect(mockList).toHaveBeenCalledWith(ORG, { athleteId: 'ath-kid', since, limit: 100 });
    expect(mockCounts).toHaveBeenCalledWith(ORG, 'ath-kid', since);
    expect(mockStopRules).toHaveBeenCalledWith(ORG);
  });

  test.each([
    ['a coach with no relationship', UNRELATED_COACH, 'ath-kid'],
    ['a coach whose grant lapsed', LAPSED_COACH, 'ath-kid'],
    ['coach of record, deleted athlete', COACH_OF_RECORD, 'ath-gone'],
    ['covering coach, deleted athlete', COVERING_COACH, 'ath-gone'],
    ['org admin, deleted athlete', ORG_ADMIN, 'ath-gone'],
    ['org admin, another gym\'s athlete', ORG_ADMIN, 'ath-away'],
    ['another gym\'s admin', OTHER_GYM_ADMIN, 'ath-kid'],
  ])('%s is refused before anything is read', async (_label, who, athleteId) => {
    mockRequirePrincipal.mockResolvedValue(who);
    const response = await GET(getRequest(`athlete_id=${athleteId}`));
    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockCounts).not.toHaveBeenCalled();
  });

  test.each(['athlete', 'parent', 'platform_owner', 'board', 'volunteer'] as const)('role %s is refused', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role, `acct-${role}`));
    const response = await GET(getRequest('athlete_id=ath-kid'));
    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('missing athlete_id is a 400', async () => {
    mockRequirePrincipal.mockResolvedValue(COACH_OF_RECORD);
    expect((await GET(getRequest(''))).status).toBe(400);
  });

  test.each(['0', '366', '2.5', 'abc'])('days=%s is a 400', async (days) => {
    mockRequirePrincipal.mockResolvedValue(COACH_OF_RECORD);
    expect((await GET(getRequest(`athlete_id=ath-kid&days=${days}`))).status).toBe(400);
  });

  test('days narrows the window for both entries and counts', async () => {
    mockRequirePrincipal.mockResolvedValue(COACH_OF_RECORD);
    const response = await GET(getRequest('athlete_id=ath-kid&days=7'));
    expect((await response.json()).window_days).toBe(7);
    const since = new Date(EVENING_AT_THE_GYM.getTime() - 7 * 86_400_000).toISOString();
    expect(mockCounts).toHaveBeenCalledWith(ORG, 'ath-kid', since);
  });
});

describe('POST /api/pilot/coach/sparring-exposure', () => {
  test('a coach of record records an entry: org and supervising account come from the principal, the day is the gym day', async () => {
    mockRequirePrincipal.mockResolvedValue(COACH_OF_RECORD);
    const response = await POST(postRequest(VALID_BODY));
    expect(response.status).toBe(201);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const input = mockRecord.mock.calls[0][0];
    expect(input).toEqual({
      organizationId: ORG,
      supervisingCoachAccountId: 'coach-record',
      athleteId: 'ath-kid',
      sessionDate: GYM_DAY,
      sparringType: 'technical',
      timeUnderImpactSec: 75,
      roundEquivalent: 2,
      partnerAthleteId: null,
      headgearWorn: true,
      gloveOz: 16,
      coachObservedIntensity: 'light',
      coachObservedHeadContact: 'incidental',
      athletePresentation: 'normal',
      coachNote: 'Kept his hands up.',
      stoppedEarly: false,
      stopRuleId: null,
      stopReason: null,
    });
    // Unlinked and auto-numbered: no activity row, no caller-chosen segment.
    expect('activityId' in input).toBe(false);
    expect('segmentNumber' in input).toBe(false);
  });

  test.each([
    ['covering coach', COVERING_COACH],
    ['organization admin', ORG_ADMIN],
  ])('%s may record', async (_label, who) => {
    mockRequirePrincipal.mockResolvedValue(who);
    expect((await POST(postRequest(VALID_BODY))).status).toBe(201);
    expect(mockRecord.mock.calls[0][0].supervisingCoachAccountId).toBe(who.accountId);
  });

  test.each([
    ['a coach with no relationship', UNRELATED_COACH, 'ath-kid'],
    ['a coach whose grant lapsed', LAPSED_COACH, 'ath-kid'],
    ['coach of record, deleted athlete', COACH_OF_RECORD, 'ath-gone'],
    ['org admin, deleted athlete', ORG_ADMIN, 'ath-gone'],
    ['org admin, another gym\'s athlete', ORG_ADMIN, 'ath-away'],
  ])('%s is refused and nothing is written', async (_label, who, athleteId) => {
    mockRequirePrincipal.mockResolvedValue(who);
    const response = await POST(postRequest({ ...VALID_BODY, athlete_id: athleteId }));
    expect(response.status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test.each(['athlete', 'parent', 'platform_owner', 'board'] as const)('role %s is refused', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role, `acct-${role}`));
    expect((await POST(postRequest(VALID_BODY))).status).toBe(403);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test.each([
    'organization_id',
    'supervising_coach_account_id',
    'activity_id',
    'segment_number',
    'device_type',
    'device_event_count',
    'risk_score',
  ])('a body carrying %s is refused, not silently dropped', async (field) => {
    mockRequirePrincipal.mockResolvedValue(COACH_OF_RECORD);
    const response = await POST(postRequest({ ...VALID_BODY, [field]: 'x' }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(`Unsupported field: ${field}`);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test.each([
    ['sparring_type', 'brawl'],
    ['coach_observed_intensity', 'savage'],
    ['coach_observed_head_contact', 'lots'],
    ['athlete_presentation', 'fine'],
    ['athlete_presentation', undefined],
    ['time_under_impact_sec', 0],
    ['time_under_impact_sec', 1801],
    ['time_under_impact_sec', 30.5],
    ['time_under_impact_sec', '60'],
    ['round_equivalent', 0],
    ['round_equivalent', 100],
    ['glove_oz', 7],
    ['glove_oz', 21],
    ['headgear_worn', 'true'],
    ['stopped_early', 'yes'],
    ['coach_note', 'x'.repeat(2001)],
    ['session_date', '2026-10-04'],
    ['session_date', '2026-02-30'],
    ['session_date', '10/01/2026'],
  ])('%s = %p is a 400', async (field, value) => {
    mockRequirePrincipal.mockResolvedValue(COACH_OF_RECORD);
    const response = await POST(postRequest({ ...VALID_BODY, [field]: value }));
    expect(response.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('a past gym day is accepted as given', async () => {
    mockRequirePrincipal.mockResolvedValue(COACH_OF_RECORD);
    expect((await POST(postRequest({ ...VALID_BODY, session_date: '2026-09-30' }))).status).toBe(201);
    expect(mockRecord.mock.calls[0][0].sessionDate).toBe('2026-09-30');
  });

  test('an early stop needs a reason', async () => {
    mockRequirePrincipal.mockResolvedValue(COACH_OF_RECORD);
    const response = await POST(postRequest({ ...VALID_BODY, stopped_early: true, stop_reason: '   ' }));
    expect(response.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('stop fields without stopped_early are refused', async () => {
    mockRequirePrincipal.mockResolvedValue(COACH_OF_RECORD);
    expect((await POST(postRequest({ ...VALID_BODY, stop_reason: 'Nose bleed' }))).status).toBe(400);
    expect((await POST(postRequest({ ...VALID_BODY, stop_rule_id: 'ust_bleeding' }))).status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('a stop rule must be one of the gym\'s current rules', async () => {
    mockRequirePrincipal.mockResolvedValue(COACH_OF_RECORD);
    const response = await POST(postRequest({
      ...VALID_BODY, stopped_early: true, stop_reason: 'Nose bleed', stop_rule_id: 'ust_made_up',
    }));
    expect(response.status).toBe(400);
    expect(mockStopRules).toHaveBeenCalledWith(ORG);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('an early stop with a current rule and a reason is recorded', async () => {
    mockRequirePrincipal.mockResolvedValue(COACH_OF_RECORD);
    const response = await POST(postRequest({
      ...VALID_BODY, stopped_early: true, stop_reason: 'Nose bleed', stop_rule_id: 'ust_bleeding',
    }));
    expect(response.status).toBe(201);
    expect(mockRecord.mock.calls[0][0]).toMatchObject({ stoppedEarly: true, stopReason: 'Nose bleed', stopRuleId: 'ust_bleeding' });
  });

  test('a partner must be another live athlete in the same gym', async () => {
    mockRequirePrincipal.mockResolvedValue(COACH_OF_RECORD);
    expect((await POST(postRequest({ ...VALID_BODY, partner_athlete_id: 'ath-away' }))).status).toBe(400);
    expect((await POST(postRequest({ ...VALID_BODY, partner_athlete_id: 'ath-gone' }))).status).toBe(400);
    expect((await POST(postRequest({ ...VALID_BODY, partner_athlete_id: 'ath-kid' }))).status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
    // A partner the coach does not coach is fine: naming a sparring partner is
    // not access to that athlete's record.
    expect((await POST(postRequest({ ...VALID_BODY, partner_athlete_id: 'ath-partner' }))).status).toBe(201);
    expect(mockRecord.mock.calls[0][0].partnerAthleteId).toBe('ath-partner');
  });

  test('non-object and non-JSON bodies are 400s', async () => {
    mockRequirePrincipal.mockResolvedValue(COACH_OF_RECORD);
    expect((await POST(postRequest('not json'))).status).toBe(400);
    expect((await POST(postRequest([VALID_BODY]))).status).toBe(400);
    expect((await POST(postRequest(null))).status).toBe(400);
  });

  test('a segment-number race that outlasts the module\'s retries is a 409', async () => {
    mockRequirePrincipal.mockResolvedValue(COACH_OF_RECORD);
    mockRecord.mockRejectedValue(new Error('SPARRING_EXPOSURE_SEGMENT_DUPLICATE'));
    expect((await POST(postRequest(VALID_BODY))).status).toBe(409);
  });
});
