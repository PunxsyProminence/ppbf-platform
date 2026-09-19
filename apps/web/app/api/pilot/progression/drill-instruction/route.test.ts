import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import * as routeModule from './route';
import { GET } from './route';
import { assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { getCoachDisplayName } from '@/src/server/pilot/achievements';
import { resolveAssignmentDrillInstruction } from '@/src/server/pilot/assignmentDrillInstruction';
import { query, queryOne, withPoolClient, withTransaction } from '@/src/server/pilot/db';
import { getAthleteDrillDetail, getDrillWithDetail } from '@/src/server/pilot/drillLibraryV3';
import { getDrill } from '@/src/server/pilot/drills';
import { getOperationalDrillLifecycle } from '@/src/server/pilot/drillVersioning';
import { requirePrincipal } from '@/src/server/pilot/http';
import { getDrillAssignmentById, recordCompletion } from '@/src/server/pilot/progression';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';

// W-D4B (OD-2026-09-19-001): opening a drill from a piece of assigned work.
//
// This route is a READ. The owner rules it carries, and what in this file
// holds each one:
//
//   Opening writes nothing        -- the module exports GET and no other verb,
//                                    and a full successful read reaches no
//                                    database call at all (the db module below
//                                    is a tripwire, not a fake).
//   The record is gated           -- "no such assignment" and "not yours" are
//                                    the same 404, byte for byte, so an
//                                    assignment id cannot be probed. Only a
//                                    refusal is folded into it: a record gate
//                                    that FAILED (the database did not answer)
//                                    is a 500, not "not found".
//   The shape follows the session -- the staff shape is an allow-list of three
//                                    roles; every other role that passes both
//                                    gates gets the athlete projection. Checked
//                                    over the whole PilotRole vocabulary, read
//                                    out of contracts.ts, so a new role is
//                                    covered the day it is added. No query
//                                    parameter selects the other shape.
//   Tenancy follows the session   -- the organization is the principal's, on
//                                    all three reads.
//   No provenance to the athlete  -- the issuer is a display name, never the
//                                    account id, and the reference pointer
//                                    never reaches the body (proved through the
//                                    real resolver at the bottom of the file).
//   No silent substitution        -- the resolver is handed the assignment row
//                                    exactly as it was read; nothing in the
//                                    request can name a different drill.
//
// What the resolver decides for each state is assignmentDrillInstruction's own
// business. Here it is mocked, so these cases prove the route's routing and
// shape -- except in the last describe, which runs the real resolver over
// mocked reads to prove the two compose without the pointer leaking.

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// requireRole stays real: the content gate is the policy itself, not a mock of
// it. Only the record gate -- which reads the database -- is replaced.
jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return { ...actual, assertActorCanAccessAthlete: jest.fn() };
});

// Every other progression export stays real, including recordCompletion. If
// the route ever reached a writer, the writer would reach the db tripwire.
jest.mock('@/src/server/pilot/progression', () => {
  const actual = jest.requireActual('@/src/server/pilot/progression');
  return { ...actual, getDrillAssignmentById: jest.fn() };
});

jest.mock('@/src/server/pilot/achievements', () => {
  const actual = jest.requireActual('@/src/server/pilot/achievements');
  return { ...actual, getCoachDisplayName: jest.fn() };
});

// withoutReferencePointer stays real; the last describe also borrows the real
// resolver through requireActual.
jest.mock('@/src/server/pilot/assignmentDrillInstruction', () => {
  const actual = jest.requireActual('@/src/server/pilot/assignmentDrillInstruction');
  return { ...actual, resolveAssignmentDrillInstruction: jest.fn() };
});

// Only reached by the real resolver in the last describe.
jest.mock('@/src/server/pilot/drills', () => {
  const actual = jest.requireActual('@/src/server/pilot/drills');
  return { ...actual, getDrill: jest.fn() };
});

jest.mock('@/src/server/pilot/drillLibraryV3', () => {
  const actual = jest.requireActual('@/src/server/pilot/drillLibraryV3');
  return { ...actual, getAthleteDrillDetail: jest.fn(), getDrillWithDetail: jest.fn() };
});

// Only reached by the real resolver's staff path in the last describe. Where the
// operational drill's lineage stands is a read of its own; left real, it would
// run into the tripwire below.
jest.mock('@/src/server/pilot/drillVersioning', () => {
  const actual = jest.requireActual('@/src/server/pilot/drillVersioning');
  return { ...actual, getOperationalDrillLifecycle: jest.fn() };
});

// A TRIPWIRE, not a fake. Every read the route performs is mocked above, so a
// correct route never gets here. Anything that does -- a real writer, a real
// reader nobody mocked -- throws, and the call is recorded for the assertion.
jest.mock('@/src/server/pilot/db', () => {
  const actual = jest.requireActual('@/src/server/pilot/db');
  const refuse = async () => {
    throw new Error('db tripwire: this suite has no database');
  };
  return {
    ...actual,
    query: jest.fn(refuse),
    queryOne: jest.fn(refuse),
    withTransaction: jest.fn(refuse),
    withPoolClient: jest.fn(refuse),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAssertAccess = assertActorCanAccessAthlete as jest.Mock;
const mockGetAssignment = getDrillAssignmentById as jest.Mock;
const mockCoachName = getCoachDisplayName as jest.Mock;
const mockResolve = resolveAssignmentDrillInstruction as jest.Mock;
const mockGetDrill = getDrill as jest.Mock;
const mockAthleteDetail = getAthleteDrillDetail as jest.Mock;
const mockCoachDetail = getDrillWithDetail as jest.Mock;
const mockLifecycle = getOperationalDrillLifecycle as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const dbCalls = [query, queryOne, withTransaction, withPoolClient] as jest.Mock[];

/**
 * The PilotRole vocabulary, READ OUT OF contracts.ts rather than restated here
 * -- the same parse drill-library/route.test.ts uses, for the reason it
 * records: a restated list agrees with itself by construction, and jest does
 * not typecheck, so a role added to the union would otherwise be tested by
 * nothing in this file. Parsed, a new role lands in the cases below the day it
 * is added, and gets whatever this file says an unlisted role gets.
 */
function roleVocabulary(): PilotRole[] {
  const contracts = fs.readFileSync(
    path.resolve(__dirname, '../../../../../src/server/pilot/contracts.ts'),
    'utf8',
  );
  const union = /export type PilotRole =([\s\S]*?);/.exec(contracts);
  if (!union) {
    throw new Error('PilotRole union not found in contracts.ts -- this parser needs updating');
  }

  const roles = Array.from(union[1].matchAll(/'([a-z_]+)'/g), (match) => match[1] as PilotRole);
  if (roles.length === 0) {
    throw new Error('PilotRole union parsed to no roles -- this parser needs updating');
  }

  return roles;
}

const ALL_ROLES: PilotRole[] = roleVocabulary();

/**
 * Refused by the content gate (coachingContentAccess.ts). Listed, not asked of
 * COACHING_CONTENT_READER_ROLES: a test that asks the policy what the policy
 * says cannot notice the policy changing.
 */
const CONTENT_DENIED_ROLES: PilotRole[] = ['board'];

/**
 * THE ALLOW-LIST. The only roles that get the staff shape. Every other role
 * that gets past both gates -- including one added to the vocabulary tomorrow
 * -- must get the athlete projection, never the provenance.
 */
const STAFF_AUDIENCE_ROLES: PilotRole[] = ['coach', 'admin', 'organization_admin'];

const CONTENT_GATE_REFUSED = ALL_ROLES.filter((role) => CONTENT_DENIED_ROLES.includes(role));
const CONTENT_GATE_ADMITTED = ALL_ROLES.filter((role) => !CONTENT_DENIED_ROLES.includes(role));

function expectedAudience(role: PilotRole): 'athlete' | 'coach' {
  return STAFF_AUDIENCE_ROLES.includes(role) ? 'coach' : 'athlete';
}

/**
 * The issuer's account id. Distinctive on purpose: the body is searched for
 * this exact string, so it must not be a substring of anything legitimate.
 */
const ISSUER_ACCOUNT_ID = 'acct-issuer-7f3a91';
const ISSUER_NAME = 'Coach Ramirez';

/** The operational drill version this work was issued against. */
const OPERATIONAL_DRILL_ID = 'drl-op-v1';

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'athlete',
    organizationId: 'org-1',
    athleteId: 'ath-1',
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

/** Staff and guardians carry no athlete id of their own. */
function principalFor(role: PilotRole): PilotPrincipal {
  return principal({ role, athleteId: role === 'athlete' ? 'ath-1' : null });
}

const assignmentRow = (overrides: Record<string, unknown> = {}) => ({
  assignment_id: 'asg-1',
  gap_id: null,
  athlete_id: 'ath-1',
  drill_id: OPERATIONAL_DRILL_ID,
  drill_name: 'Catch and Return',
  drill_description: 'Partner leads, you catch and return.',
  drill_display_name: 'Catch and Return',
  drill_display_description: 'Partner leads, you catch and return.',
  drill_category: 'defense',
  drill_cues: ['Hand home first'],
  drill_difficulty: 'intermediate',
  rep_count: 20,
  duration_minutes: 10,
  frequency_per_week: 3,
  due_date: '2026-09-30',
  status: 'assigned',
  completion_percentage: 0,
  assigned_by_account_id: ISSUER_ACCOUNT_ID,
  assigned_at: '2026-09-19T12:00:00.000Z',
  created_at: '2026-09-19T12:00:00.000Z',
  ...overrides,
});

/** The athlete projection as the resolver returns it: no drill_id. */
const athleteDrill = {
  name: 'Catch and Return',
  purpose: 'Catching the straight punch',
  setup: 'none',
  execution: 'Partner leads, you catch and return.',
  contact_level: 'light',
  requires_coach_authorization: false,
  cues: ['Hand home first'],
  what_good_looks_like: 'Glove back to the chin before the return.',
  what_bad_looks_like: 'Reaching for the punch.',
  common_errors: 'Dropping the rear hand.',
  corrections: 'Catch at the face, not in front of it.',
  equipment_needed: 'gloves',
  scale_levels: [],
  stop_rules: [{ ordinal: 1, condition_text: 'Dizziness', scope: 'universal', rule_kind: 'medical' }],
};

/** The staff reference detail as the resolver returns it: the full row, WITH its drill_id. */
const coachDrill = { drill_id: 'ref-v1', name: 'Catch and Return', stop_rules: [], scale_levels: [], cues: [] };

/**
 * The staff 'available' answer. athlete_can_open is the resolver's own answer
 * to "can the athlete open this from the work?", and both values appear in the
 * fixtures below: `false` is the one a route that dropped, defaulted or
 * truthiness-filtered the field would lose.
 */
const coachInstruction = (lifecycle: 'current' | 'changed' | 'retired', athleteCanOpen: boolean) => ({
  state: 'available',
  audience: 'coach',
  drill: coachDrill,
  operational_lifecycle: lifecycle,
  athlete_can_open: athleteCanOpen,
});

/** Every state the resolver can answer, keyed by a readable label. */
const INSTRUCTION_STATES: Array<[string, Record<string, unknown>]> = [
  ['available (athlete)', { state: 'available', audience: 'athlete', drill: athleteDrill }],
  ['available (coach, the athlete can open it)', coachInstruction('current', true)],
  ['available (coach, the athlete cannot open it)', coachInstruction('changed', false)],
  ['no_drill', { state: 'no_drill' }],
  ['gym_written', { state: 'gym_written' }],
  ['unavailable', { state: 'unavailable' }],
];

const getRequest = (query_?: string) =>
  new NextRequest(`http://localhost/api/pilot/progression/drill-instruction${query_ ? `?${query_}` : ''}`);

/** Nothing past the content gate ran. */
function expectNothingRead() {
  expect(mockGetAssignment).not.toHaveBeenCalled();
  expect(mockAssertAccess).not.toHaveBeenCalled();
  expect(mockResolve).not.toHaveBeenCalled();
  expect(mockCoachName).not.toHaveBeenCalled();
}

/** Nothing past the record gate ran: no instruction, no issuer name. */
function expectNothingDisclosed() {
  expect(mockResolve).not.toHaveBeenCalled();
  expect(mockCoachName).not.toHaveBeenCalled();
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  // The happy path, as defaults. Each case overrides what it is about.
  mockGetAssignment.mockResolvedValue(assignmentRow());
  mockAssertAccess.mockResolvedValue(undefined);
  mockResolve.mockResolvedValue({ state: 'available', audience: 'athlete', drill: athleteDrill });
  mockCoachName.mockResolvedValue(ISSUER_NAME);
  // jsonError logs the error class on a 500. Silenced, not ignored: the
  // failure cases below assert what it was given.
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  consoleError.mockRestore();
  jest.clearAllMocks();
  // clearAllMocks keeps queued Once values. A case that fails before it has
  // consumed its queue would hand the leftovers to the next case, and one
  // failure would read as a cascade. Every mock in this list gets its defaults
  // back from a beforeEach, so all of them can be emptied. The db tripwire is
  // not in the list: its implementation IS the refusal.
  for (const mock of [
    mockRequirePrincipal,
    mockAssertAccess,
    mockGetAssignment,
    mockCoachName,
    mockResolve,
    mockGetDrill,
    mockAthleteDetail,
    mockCoachDetail,
    mockLifecycle,
  ]) {
    mock.mockReset();
  }
});

describe('GET /api/pilot/progression/drill-instruction', () => {
  describe('the gates, in order', () => {
    test('401 when unauthenticated, and nothing is read', async () => {
      mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

      const res = await GET(getRequest('assignment_id=asg-1'));

      expect(res.status).toBe(401);
      expectNothingRead();
    });

    test('the role vocabulary was read in full, so the cases drawn from it are not quietly short', () => {
      // Every role this file names must have come out of the parse. A parser
      // that matched only part of the union would drop roles from the
      // vocabulary-wide cases below without failing any of them.
      expect(ALL_ROLES).toEqual(
        expect.arrayContaining([
          ...CONTENT_DENIED_ROLES,
          ...STAFF_AUDIENCE_ROLES,
          'athlete',
          'parent',
          'platform_owner',
          'volunteer',
          'staff',
        ]),
      );
      expect(new Set(ALL_ROLES).size).toBe(ALL_ROLES.length);
    });

    test.each(CONTENT_GATE_REFUSED)('the %s role is refused with 403 before any read', async (role) => {
      // The status alone would pass if the content gate ran AFTER the
      // assignment read, or after the record gate. A refusal that has already
      // looked the assignment up is not a refusal.
      mockRequirePrincipal.mockResolvedValueOnce(principalFor(role));

      const res = await GET(getRequest('assignment_id=asg-1'));

      expect(res.status).toBe(403);
      expectNothingRead();
    });

    test('the board gets 403, not 400, even when assignment_id is missing', async () => {
      // coachingContentAccess.ts puts the gate before any parameter parsing:
      // "may I read this?" must not be answered differently depending on how
      // well-formed the request was.
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('board'));

      const res = await GET(getRequest());

      expect(res.status).toBe(403);
      expectNothingRead();
    });

    test.each(['', 'assignment_id='])('400 when assignment_id is missing (%p), and nothing is read', async (query_) => {
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('coach'));

      const res = await GET(getRequest(query_));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'Missing assignment_id' });
      expectNothingRead();
    });

    test.each<PilotRole>(['platform_owner', 'volunteer', 'staff'])(
      '%s passes the content gate but is stopped at the record gate with the hidden 404',
      async (role) => {
        // The route header says every reader role outside the athlete's own
        // circle is refused by the record gate. assertActorCanAccessAthlete
        // throws for all three of these (access.ts); here it is made to, and
        // the route must turn that into the same 404 as a missing assignment.
        mockRequirePrincipal.mockResolvedValueOnce(principalFor(role));
        mockAssertAccess.mockRejectedValueOnce(new Error('Forbidden: role not allowed'));

        const res = await GET(getRequest('assignment_id=asg-1'));

        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found' });
        expect(mockGetAssignment).toHaveBeenCalledWith('org-1', 'asg-1');
        expect(mockAssertAccess).toHaveBeenCalledTimes(1);
        expectNothingDisclosed();
      },
    );
  });

  describe('"no such assignment" and "not yours" are one answer', () => {
    test('an unknown assignment is 404 { error: "Not found" }, and the record gate is never consulted', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('athlete'));
      mockGetAssignment.mockResolvedValueOnce(null);

      const res = await GET(getRequest('assignment_id=does-not-exist'));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect(mockGetAssignment).toHaveBeenCalledWith('org-1', 'does-not-exist');
      expect(mockAssertAccess).not.toHaveBeenCalled();
      expectNothingDisclosed();
    });

    test('a forbidden assignment answers byte-for-byte like a missing one', async () => {
      // Compared as whole responses, not as two separately-plausible 404s. A
      // route that said { error: 'Forbidden' } with 404, or 403 with
      // { error: 'Not found' }, would pass either half on its own.
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('athlete'));
      mockGetAssignment.mockResolvedValueOnce(null);
      const missing = await GET(getRequest('assignment_id=asg-1'));

      mockRequirePrincipal.mockResolvedValueOnce(principalFor('athlete'));
      mockGetAssignment.mockResolvedValueOnce(assignmentRow({ athlete_id: 'ath-other' }));
      mockAssertAccess.mockRejectedValueOnce(new Error('Forbidden: athlete cannot access another athlete record'));
      const forbidden = await GET(getRequest('assignment_id=asg-1'));

      expect(forbidden.status).toBe(missing.status);
      expect(forbidden.headers.get('content-type')).toBe(missing.headers.get('content-type'));
      expect(await forbidden.text()).toBe(await missing.text());
      expect(forbidden.status).toBe(404);
      expectNothingDisclosed();
    });

    test.each<[PilotRole, string]>([
      ['athlete', 'Forbidden: athlete cannot access another athlete record'],
      ['parent', 'Forbidden: parent not linked to athlete'],
      ['coach', 'Forbidden: coach not assigned to athlete'],
      ['admin', 'Forbidden: athlete does not belong to organization'],
      ['organization_admin', 'Forbidden: athlete does not belong to organization'],
    ])('the %s role, refused by the record gate (%s), gets the hidden 404 and never the reason', async (role, reason) => {
      // Each refusal carries a message that would, if forwarded, say WHY --
      // "not linked", "not assigned", "not in this gym". The route must
      // forward none of them: the body is the fixed hidden-not-found body.
      // These are the messages access.ts actually throws for each role; the
      // real-gate cases below prove that against the gate itself.
      mockRequirePrincipal.mockResolvedValueOnce(principalFor(role));
      mockAssertAccess.mockRejectedValueOnce(new Error(reason));

      const res = await GET(getRequest('assignment_id=asg-1'));

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expectNothingDisclosed();
    });

    test("the record gate checks the assignment's own athlete, never one named in the request", async () => {
      // An athlete id in the query would let a caller point the gate at an
      // athlete they CAN see while reading an assignment that belongs to one
      // they cannot.
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('coach'));
      mockGetAssignment.mockResolvedValueOnce(assignmentRow({ athlete_id: 'ath-7' }));

      await GET(getRequest('assignment_id=asg-1&athlete_id=ath-mine&athleteId=ath-mine'));

      expect(mockAssertAccess).toHaveBeenCalledTimes(1);
      expect(mockAssertAccess).toHaveBeenCalledWith(expect.objectContaining({ role: 'coach' }), 'ath-7');
    });

    describe('against the real record gate', () => {
      // The route folds a refusal into the hidden 404 by its wording: every
      // refusal access.ts makes starts 'Forbidden', and anything else is let
      // through as a fault. The mocked rejections above take that wording on
      // trust. Here the REAL gate runs over a database with no roster row, no
      // coverage and no guardian link for anyone, so it refuses every role past
      // the content gate in its own words -- and a refusal worded any other
      // way, today or after an edit to access.ts, would surface as a 500 and
      // fail here.
      const tripwire = mockQueryOne.getMockImplementation();

      beforeEach(() => {
        mockAssertAccess.mockImplementation(
          jest.requireActual('@/src/server/pilot/access').assertActorCanAccessAthlete,
        );
        mockQueryOne.mockImplementation(async () => null);
      });

      afterEach(() => {
        // Reset first, so a Once left queued by a failed case cannot outlive
        // it, then put the tripwire back.
        mockQueryOne.mockReset();
        mockQueryOne.mockImplementation(tripwire);
      });

      test.each(CONTENT_GATE_ADMITTED)(
        'the %s role, refused by the real gate, answers byte-for-byte like a missing assignment',
        async (role) => {
          mockRequirePrincipal.mockResolvedValueOnce(principalFor(role));
          mockGetAssignment.mockResolvedValueOnce(null);
          const missing = await GET(getRequest('assignment_id=asg-1'));

          // Another athlete's work, so the athlete role is refused as well.
          mockRequirePrincipal.mockResolvedValueOnce(principalFor(role));
          mockGetAssignment.mockResolvedValueOnce(assignmentRow({ athlete_id: 'ath-other' }));
          const refused = await GET(getRequest('assignment_id=asg-1'));

          // The gate really did refuse, in its own words -- the 404 is not the
          // tripwire or some other failure dressed up.
          expect(mockAssertAccess).toHaveBeenCalledTimes(1);
          await expect(mockAssertAccess.mock.results[0].value).rejects.toThrow(/^Forbidden/);
          expect(refused.status).toBe(404);
          expect(refused.headers.get('content-type')).toBe(missing.headers.get('content-type'));
          expect(await refused.text()).toBe(await missing.text());
          expectNothingDisclosed();
        },
      );

      test('the real gate FAILING, rather than refusing, is a 500 and never the hidden 404', async () => {
        // A coach who is not the athlete's coach of record falls through to the
        // coverage read. That read failing is an outage, and access.ts rethrows
        // it on purpose (only a missing relation means "no coverage"). The
        // route must pass it on as a fault, not tell the coach the work does
        // not exist.
        mockRequirePrincipal.mockResolvedValueOnce(principalFor('coach'));
        mockQueryOne
          .mockImplementationOnce(async () => null)
          .mockImplementationOnce(async () => {
            throw Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' });
          });

        const res = await GET(getRequest('assignment_id=asg-1'));

        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'Internal server error' });
        expect(mockQueryOne).toHaveBeenCalledTimes(2);
        expectNothingDisclosed();
      });
    });
  });

  describe('the shape follows the session, never the request', () => {
    test.each(CONTENT_GATE_ADMITTED.map((role) => [role, expectedAudience(role)] as const))(
      'the %s role, once past both gates, is resolved for the %s audience',
      async (role, audience) => {
        // EVERY role in the vocabulary that the content gate admits, not the
        // five that reach this line in production. platform_owner, volunteer
        // and staff are refused by the real record gate today; here it is made
        // to pass for them, so what decides the shape is the route's own
        // allow-list and nothing else. A route that named the athlete side
        // instead ("athlete and parent get the projection, everyone else is
        // staff") hands all three -- and any role added later -- the full
        // reference detail the moment the record gate lets them through.
        mockRequirePrincipal.mockResolvedValueOnce(principalFor(role));
        mockAssertAccess.mockResolvedValueOnce(undefined);

        const res = await GET(getRequest('assignment_id=asg-1'));

        expect(res.status).toBe(200);
        expect(mockGetAssignment).toHaveBeenCalledWith('org-1', 'asg-1');
        expect(mockAssertAccess).toHaveBeenCalledTimes(1);
        expect(mockAssertAccess).toHaveBeenCalledWith(expect.objectContaining({ role }), 'ath-1');
        expect(mockResolve).toHaveBeenCalledTimes(1);
        expect(mockResolve).toHaveBeenCalledWith('org-1', expect.objectContaining({ assignment_id: 'asg-1' }), audience);
      },
    );

    test.each<PilotRole>(['athlete', 'parent'])(
      'the %s role cannot ask for the staff shape with a parameter',
      async (role) => {
        // The staff shape carries the full reference detail, including the
        // reference drill_id. There is no parameter that selects it; this
        // proves the route does not read any of the obvious spellings.
        mockRequirePrincipal.mockResolvedValueOnce(principalFor(role));

        await GET(getRequest('assignment_id=asg-1&audience=coach&view=coach&role=coach&shape=full'));

        expect(mockResolve).toHaveBeenCalledWith('org-1', expect.any(Object), 'athlete');
      },
    );
  });

  describe('the organization and the drill come from the server', () => {
    test('every read is scoped to the session organization, whatever the query says', async () => {
      // A test that only ever sends benign input cannot tell "never reads the
      // organization from the request" apart from "was not asked to" -- the
      // lesson drill-library/route.test.ts records from mutation testing.
      const hostile = 'org=org-victim&organization_id=org-victim&organizationId=org-victim';
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('coach'));

      const res = await GET(getRequest(`assignment_id=asg-1&${hostile}`));

      expect(res.status).toBe(200);
      expect(mockGetAssignment).toHaveBeenCalledWith('org-1', 'asg-1');
      expect(mockResolve).toHaveBeenCalledWith('org-1', expect.any(Object), 'coach');
      expect(mockCoachName).toHaveBeenCalledWith('org-1', ISSUER_ACCOUNT_ID);
    });

    test('the resolver is handed the assignment exactly as it was read, so nothing can substitute a drill', async () => {
      // No silent version substitution starts here: the assignment names the
      // operational version it was issued against, and that row -- the same
      // object -- is what the resolver follows. A drill id in the request is
      // not a way to open a different version, or a different drill.
      const row = assignmentRow();
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('athlete'));
      mockGetAssignment.mockResolvedValueOnce(row);

      await GET(getRequest('assignment_id=asg-1&drill_id=drl-op-v2&reference_drill_id=ref-v2'));

      expect(mockResolve).toHaveBeenCalledTimes(1);
      const [, passed] = mockResolve.mock.calls[0];
      expect(passed).toBe(row);
      expect(passed.drill_id).toBe(OPERATIONAL_DRILL_ID);
    });
  });

  describe('the body', () => {
    test.each(INSTRUCTION_STATES)('spreads the %s state beside the assignment id and issuer name', async (_label, instruction) => {
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('coach'));
      mockResolve.mockResolvedValueOnce(instruction);

      const res = await GET(getRequest('assignment_id=asg-1'));

      expect(res.status).toBe(200);
      // Exact, so the body can carry nothing the route did not choose to put
      // there: no athlete_id, no operational drill_id, no snapshot fields.
      expect(await res.json()).toEqual({ assignment_id: 'asg-1', assigned_by: ISSUER_NAME, ...instruction });
    });

    test.each<PilotRole>(['athlete', 'parent', 'coach', 'admin', 'organization_admin'])(
      'the %s role is told who assigned the work by name, and the account id appears nowhere in the body',
      async (role) => {
        // Searched as raw text, across every state, rather than checking one
        // key: an id nested anywhere -- under the instruction, under a renamed
        // key -- is the same disclosure.
        for (const [, instruction] of INSTRUCTION_STATES) {
          mockRequirePrincipal.mockResolvedValueOnce(principalFor(role));
          mockResolve.mockResolvedValueOnce(instruction);

          const res = await GET(getRequest('assignment_id=asg-1'));
          const text = await res.text();

          expect(res.status).toBe(200);
          expect(JSON.parse(text).assigned_by).toBe(ISSUER_NAME);
          expect(text).not.toContain(ISSUER_ACCOUNT_ID);
          expect(text).not.toContain('assigned_by_account_id');
        }
        expect(mockCoachName).toHaveBeenCalledWith('org-1', ISSUER_ACCOUNT_ID);
      },
    );

    test.each(STAFF_AUDIENCE_ROLES.flatMap((role) => [true, false].map((canOpen) => [role, canOpen] as const)))(
      'the %s role reads athlete_can_open: %p exactly as the resolver answered it',
      async (role, canOpen) => {
        // Whether the athlete can open the instruction is the resolver's answer
        // (it runs the athlete's own read). The route decides nothing about it:
        // it must not drop the field, default it, or turn `false` into a
        // missing key -- a coach panel reads "missing" as "does not say" and
        // stays silent exactly when the athlete is locked out. Every staff role,
        // not just 'coach': all three get the staff shape.
        const instruction = coachInstruction('current', canOpen);
        mockRequirePrincipal.mockResolvedValueOnce(principalFor(role));
        mockResolve.mockResolvedValueOnce(instruction);

        const res = await GET(getRequest('assignment_id=asg-1'));
        const body = await res.json();

        expect(res.status).toBe(200);
        expect(mockResolve).toHaveBeenCalledWith('org-1', expect.any(Object), 'coach');
        expect(body).toHaveProperty('athlete_can_open');
        expect(body.athlete_can_open).toBe(canOpen);
        expect(body).toEqual({ assignment_id: 'asg-1', assigned_by: ISSUER_NAME, ...instruction });
      },
    );
  });

  describe('opening a drill writes nothing', () => {
    test('the module answers GET and no other verb', () => {
      // Next.js routes a verb to a route file only if the file exports it, so
      // the export list IS the route's surface. A POST added here later -- to
      // "mark as viewed", say -- would make opening a drill a write.
      const exported = Object.keys(routeModule).filter(
        (key) => typeof (routeModule as Record<string, unknown>)[key] === 'function',
      );
      expect(exported).toEqual(['GET']);

      const verbs = routeModule as Record<string, unknown>;
      for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        expect(verbs[verb]).toBeUndefined();
      }
    });

    test('the tripwire is live: a real writer reached from this suite is caught, not run', async () => {
      // Without this, "no database call" could pass because the mocks above
      // swallowed the call, or because the real progression module resolved a
      // different db than the one mocked here. recordCompletion is the writer
      // behind POST /completions and is left real in this suite on purpose.
      await expect(
        recordCompletion({ organizationId: 'org-1', assignmentId: 'asg-1', athleteId: 'ath-1' }),
      ).rejects.toThrow('db tripwire');
      expect(withTransaction).toHaveBeenCalledTimes(1);
    });

    test.each<PilotRole>(['athlete', 'parent', 'coach'])(
      'a full successful read by the %s role reaches no database call',
      async (role) => {
        // Every read the route needs is mocked. Everything else in the
        // progression module -- recordCompletion and the progress update it
        // runs -- is real, and would have to go through withTransaction to
        // write. None of the tripwires may fire.
        mockRequirePrincipal.mockResolvedValueOnce(principalFor(role));

        const res = await GET(getRequest('assignment_id=asg-1'));

        expect(res.status).toBe(200);
        for (const call of dbCalls) {
          expect(call).not.toHaveBeenCalled();
        }
      },
    );
  });

  describe('failure', () => {
    // The message is shaped like what a driver actually throws, carrying
    // exactly what must not leave the server.
    const leaky = 'connect ECONNREFUSED postgres://svc:hunter2@db.internal:5432 select * from pilot.drills';

    test('a failure inside the resolver is a 500 with the generic body', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('athlete'));
      mockResolve.mockRejectedValueOnce(new Error(leaky));

      const res = await GET(getRequest('assignment_id=asg-1'));
      const text = await res.text();

      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: 'Internal server error' });
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('pilot.drills');
      // The log line carries the error class only, not the message.
      expect(consoleError).toHaveBeenCalledWith('unhandled-route-error', { errorClass: 'Error' });
    });

    test('a failure naming the issuer is the same 500, not a partial body', async () => {
      // The two reads run together; either one failing fails the answer. A
      // body with the instruction and no issuer would be a different contract.
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('coach'));
      mockCoachName.mockRejectedValueOnce(new Error(leaky));

      const res = await GET(getRequest('assignment_id=asg-1'));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
    });

    test('a failure reading the assignment is a 500, not the hidden 404', async () => {
      // Only the RECORD GATE is folded into the hidden 404. An outage reading
      // the assignment must not tell a caller "that assignment does not
      // exist", and must not look to a client like one.
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('athlete'));
      mockGetAssignment.mockRejectedValueOnce(new Error(leaky));

      const res = await GET(getRequest('assignment_id=asg-1'));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'Internal server error' });
      expect(mockAssertAccess).not.toHaveBeenCalled();
      expectNothingDisclosed();
    });

    test('a record gate that FAILS is a 500 with the generic body, not the hidden 404', async () => {
      // The record gate reads the database (the roster, coverage, guardian
      // links). A driver error from it is an outage, not a refusal: folded
      // into "Not found" it would tell a guardian their child's work does not
      // exist, and hide the outage from whoever runs the gym's server.
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('parent'));
      mockAssertAccess.mockRejectedValueOnce(
        Object.assign(new Error('connection terminated unexpectedly'), { code: '57P01' }),
      );

      const res = await GET(getRequest('assignment_id=asg-1'));
      const text = await res.text();

      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: 'Internal server error' });
      expect(text).not.toContain('connection terminated');
      // The outage reaches the server log as what it is -- a driver fault,
      // with its SQLSTATE -- and the message stays out of it.
      expect(consoleError).toHaveBeenCalledWith('unhandled-route-error', { errorClass: 'Error', code: '57P01' });
      expect(mockAssertAccess).toHaveBeenCalledTimes(1);
      expectNothingDisclosed();
    });

    test('the same gate REFUSING is the hidden 404, byte for byte like a missing assignment', async () => {
      // The other half of the case above, on the same role and the same
      // assignment, so the only thing that differs is fault versus refusal.
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('parent'));
      mockGetAssignment.mockResolvedValueOnce(null);
      const missing = await GET(getRequest('assignment_id=asg-1'));

      mockRequirePrincipal.mockResolvedValueOnce(principalFor('parent'));
      mockAssertAccess.mockRejectedValueOnce(new Error('Forbidden: parent not linked to athlete'));
      const refused = await GET(getRequest('assignment_id=asg-1'));

      expect(refused.status).toBe(404);
      expect(refused.headers.get('content-type')).toBe(missing.headers.get('content-type'));
      expect(await refused.text()).toBe(await missing.text());
      expect(consoleError).not.toHaveBeenCalled();
      expectNothingDisclosed();
    });
  });

  /**
   * The route and the REAL resolver together, over mocked reads.
   *
   * Every case above mocks the resolver, which means the athlete body carries
   * no reference pointer only because the fixture has none. Here the resolver
   * is real and the reference read hands back a detail WITH its drill_id -- the
   * reference pointer, as getAthleteDrillDetail really returns it -- so the
   * case fails if either the resolver stops removing it or the route adds it
   * back.
   */
  describe('through the real resolver', () => {
    const REFERENCE_ID = 'ref-v1-9c0e27';

    beforeEach(() => {
      const actual = jest.requireActual('@/src/server/pilot/assignmentDrillInstruction');
      mockResolve.mockImplementation(actual.resolveAssignmentDrillInstruction);
      mockGetDrill.mockResolvedValue({
        organization_id: 'org-1',
        drill_id: OPERATIONAL_DRILL_ID,
        name: 'Catch and Return',
        active: true,
        reference_drill_id: REFERENCE_ID,
      });
    });

    test('an athlete gets the instruction, and the reference pointer appears nowhere in the body', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('athlete'));
      mockAthleteDetail.mockResolvedValueOnce({ drill_id: REFERENCE_ID, ...athleteDrill });

      const res = await GET(getRequest('assignment_id=asg-1'));
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(JSON.parse(text)).toEqual({
        assignment_id: 'asg-1',
        assigned_by: ISSUER_NAME,
        state: 'available',
        audience: 'athlete',
        drill: athleteDrill,
      });
      expect(text).not.toContain(REFERENCE_ID);
      expect(text).not.toContain('reference_drill_id');
      expect(text).not.toContain(ISSUER_ACCOUNT_ID);
      // A staff-only status line. The athlete is reading the instruction; being
      // told whether they could is not theirs to receive.
      expect(text).not.toContain('athlete_can_open');
    });

    test("the reference read follows the assignment's own operational row, once, and nothing else", async () => {
      // The chain has no lookup along the way: assignment.drill_id -> that
      // operational row -> ITS reference_drill_id. One read of each, by id.
      // A route or resolver that went to a lineage head would need another
      // read, or a different id, and fails here.
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('athlete'));
      mockAthleteDetail.mockResolvedValueOnce({ drill_id: REFERENCE_ID, ...athleteDrill });

      await GET(getRequest('assignment_id=asg-1'));

      expect(mockGetDrill).toHaveBeenCalledTimes(1);
      expect(mockGetDrill).toHaveBeenCalledWith('org-1', OPERATIONAL_DRILL_ID);
      expect(mockAthleteDetail).toHaveBeenCalledTimes(1);
      expect(mockAthleteDetail).toHaveBeenCalledWith('org-1', REFERENCE_ID);
      // The athlete never reaches the unfiltered staff read, or the staff-only
      // lifecycle status.
      expect(mockCoachDetail).not.toHaveBeenCalled();
      expect(mockLifecycle).not.toHaveBeenCalled();
      for (const call of dbCalls) {
        expect(call).not.toHaveBeenCalled();
      }
    });

    test('a reference this gym no longer offers the athlete is "unavailable", with the assignment still answered', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('parent'));
      mockAthleteDetail.mockResolvedValueOnce(null);

      const res = await GET(getRequest('assignment_id=asg-1'));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ assignment_id: 'asg-1', assigned_by: ISSUER_NAME, state: 'unavailable' });
      expect(mockCoachDetail).not.toHaveBeenCalled();
    });

    test('a coach gets the full reference detail, where the operational drill stands now, and whether the athlete can open it', async () => {
      // The version the work was issued against is inactive, but the gym
      // refined it and runs the successor: 'changed', not 'retired'. The
      // instruction is still the one that version pinned.
      mockRequirePrincipal.mockResolvedValueOnce(principalFor('coach'));
      mockGetDrill.mockResolvedValueOnce({
        organization_id: 'org-1',
        drill_id: OPERATIONAL_DRILL_ID,
        name: 'Catch and Return',
        active: false,
        reference_drill_id: REFERENCE_ID,
      });
      mockLifecycle.mockResolvedValueOnce('changed');
      const detail = { drill_id: REFERENCE_ID, name: 'Catch and Return', stop_rules: [], scale_levels: [], cues: [] };
      mockCoachDetail.mockResolvedValueOnce(detail);
      // The athlete's own read still finds it: the promotion is live.
      mockAthleteDetail.mockResolvedValueOnce({ drill_id: REFERENCE_ID, ...athleteDrill });

      const res = await GET(getRequest('assignment_id=asg-1'));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        assignment_id: 'asg-1',
        assigned_by: ISSUER_NAME,
        state: 'available',
        audience: 'coach',
        drill: detail,
        operational_lifecycle: 'changed',
        athlete_can_open: true,
      });
      expect(mockCoachDetail).toHaveBeenCalledWith('org-1', REFERENCE_ID);
      expect(mockLifecycle).toHaveBeenCalledWith('org-1', OPERATIONAL_DRILL_ID);
      // The answer comes from running the athlete's read on the SAME reference
      // version the staff detail came from -- once, by id -- not from a
      // re-derived predicate or a lineage head.
      expect(mockAthleteDetail).toHaveBeenCalledTimes(1);
      expect(mockAthleteDetail).toHaveBeenCalledWith('org-1', REFERENCE_ID);
      for (const call of dbCalls) {
        expect(call).not.toHaveBeenCalled();
      }
    });

    test.each(
      STAFF_AUDIENCE_ROLES.flatMap((role) =>
        [
          ['the athlete read finds it', true],
          ['the athlete read withholds it', false],
        ].map(([why, canOpen]) => [role, why as string, canOpen as boolean] as const),
      ),
    )('the %s role, when %s, reads athlete_can_open: %p beside the full detail', async (role, _why, canOpen) => {
      // The same reads, over both answers from the athlete's own read. The
      // staff read is unfiltered, so the instruction stays 'available' to staff
      // either way; only the boolean moves. The athlete read feeds that boolean
      // and nothing else: none of the athlete projection reaches the staff body.
      mockRequirePrincipal.mockResolvedValueOnce(principalFor(role));
      mockLifecycle.mockResolvedValueOnce('current');
      const detail = { drill_id: REFERENCE_ID, name: 'Catch and Return', stop_rules: [], scale_levels: [], cues: [] };
      mockCoachDetail.mockResolvedValueOnce(detail);
      mockAthleteDetail.mockResolvedValueOnce(canOpen ? { drill_id: REFERENCE_ID, ...athleteDrill } : null);

      const res = await GET(getRequest('assignment_id=asg-1'));
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(JSON.parse(text)).toEqual({
        assignment_id: 'asg-1',
        assigned_by: ISSUER_NAME,
        state: 'available',
        audience: 'coach',
        drill: detail,
        operational_lifecycle: 'current',
        athlete_can_open: canOpen,
      });
      expect(text).not.toContain(athleteDrill.what_good_looks_like);
      expect(mockCoachDetail).toHaveBeenCalledWith('org-1', REFERENCE_ID);
      expect(mockAthleteDetail).toHaveBeenCalledTimes(1);
      expect(mockAthleteDetail).toHaveBeenCalledWith('org-1', REFERENCE_ID);
      for (const call of dbCalls) {
        expect(call).not.toHaveBeenCalled();
      }
    });
  });
});
