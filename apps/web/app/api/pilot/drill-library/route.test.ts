import fs from 'node:fs';
import path from 'node:path';

import { NextRequest } from 'next/server';

import { GET } from './route';
import { ValidationError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  getAthleteDrillDetail,
  getDrillWithDetail,
  listAthleteDrillLibrary,
  listDrillLibrary,
  listReferenceLifecycles,
} from '@/src/server/pilot/drillLibraryV3';
import type { ReferenceLifecycle } from '@/src/server/pilot/drillLibraryV3';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import type { PilotRole } from '@/src/server/pilot/contracts';

// The question this file used to record is now answered.
//
// It was written as a characterization test because three surfaces serving one
// class of content held three postures: /api/pilot/drills gated to seven roles
// excluding board and platform_owner, while this route and the cue library
// gated to nothing at all -- each with a written rationale, none citing the
// others. The header here said which posture was right was an OPEN OWNER
// DECISION, and that when it was decided "the expectations below change with
// the code, and that is the point."
//
// It was decided on 2026-08-27. The board is DENIED: oversight and aggregate
// governance, not operational coaching content. The platform owner is ALLOWED,
// organization-scoped -- reaching this gym's drills through the organization
// its own principal carries, and no other. The seven organization member roles
// are preserved exactly. coachingContentAccess.ts holds the decision; these
// cases are what makes it true of this route.
//
// The route reads pilot.drill_library, a different table from
// /api/pilot/drills' pilot.drills. Two generations of drill library, same
// content class -- which is why one answer now covers both.

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/drillLibraryV3', () => {
  const actual = jest.requireActual('@/src/server/pilot/drillLibraryV3');
  return {
    ...actual,
    listDrillLibrary: jest.fn(),
    getDrillWithDetail: jest.fn(),
    listAthleteDrillLibrary: jest.fn(),
    getAthleteDrillDetail: jest.fn(),
    listReferenceLifecycles: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listDrillLibrary as jest.Mock;
const mockDetail = getDrillWithDetail as jest.Mock;
const mockAthleteList = listAthleteDrillLibrary as jest.Mock;
const mockAthleteDetail = getAthleteDrillDetail as jest.Mock;
const mockLifecycles = listReferenceLifecycles as jest.Mock;

beforeEach(() => {
  // W-D4C. Every AUTHOR read (coach, organization_admin, admin) now also asks
  // where the gym's reference drills stand. An empty map is the neutral
  // answer; the cases that care about the lifecycle set their own. Reset per
  // case because clearAllMocks below clears calls, not implementations -- a
  // map left over from one case would otherwise be the answer the next case
  // silently reads.
  mockLifecycles.mockResolvedValue({});
});

afterEach(() => {
  jest.clearAllMocks();
});

function principal(role: PilotRole): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  } as PilotPrincipal;
}

const getRequest = (query = '') =>
  new NextRequest(`http://localhost/api/pilot/drill-library${query ? `?${query}` : ''}`);

/**
 * The partition. Listed in full rather than derived from
 * COACHING_CONTENT_READER_ROLES: a test that asks the policy what the policy
 * says cannot notice the policy changing.
 */
const ADMITTED_ROLES: PilotRole[] = [
  'platform_owner',
  'organization_admin',
  'admin',
  'coach',
  'athlete',
  'parent',
  'volunteer',
  'staff',
];

const DENIED_ROLES: PilotRole[] = ['board'];

/**
 * W-D4C, the second partition, and a different cut through the same eight
 * admitted roles. Where a reference stands in this gym -- including what it
 * retired -- is governance for the people who promote, retire and restore:
 * the three authoring roles, the same three /api/pilot/drills shows retired
 * drills to. Every other admitted reader gets the library in exactly the shape
 * it had before W-D4C, and the lifecycle read never runs for them.
 *
 * Listed in full for the same reason as the partition above, and checked
 * against the vocabulary parsed out of contracts.ts below: a new role has to
 * be put on one side of this line on purpose, not inherit either answer.
 */
const AUTHOR_ROLES: PilotRole[] = ['coach', 'organization_admin', 'admin'];

const PLAIN_READER_ROLES: PilotRole[] = ['athlete', 'parent', 'volunteer', 'staff', 'platform_owner'];

/**
 * The vocabulary, READ OUT OF contracts.ts rather than restated here.
 *
 * It was restated here, and that made the exhaustiveness case below a
 * comparison of three literals sitting in one file, which agree with each
 * other by construction. Measured: adding a tenth member to the PilotRole
 * union left all 61 cases in the four affected suites green, so the case
 * proved nothing about the vocabulary it named. Parsing the union is what
 * makes it fail when the vocabulary grows, and `npx jest` is the command that
 * enforces it -- jest does not typecheck, so nothing type-level would.
 */
function roleVocabulary(): PilotRole[] {
  const contracts = fs.readFileSync(
    path.resolve(__dirname, '../../../../src/server/pilot/contracts.ts'),
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

describe('who may read the v3 drill library', () => {
  it('accounts for every role in the vocabulary, so a new one cannot default in', () => {
    // ALL_ROLES comes from the PilotRole union itself, so a role added there
    // lands on neither side of this partition and fails here.
    expect([...ADMITTED_ROLES, ...DENIED_ROLES].sort()).toEqual([...ALL_ROLES].sort());
  });

  it.each(ADMITTED_ROLES)('%s is admitted', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockList.mockResolvedValue([]);
    mockAthleteList.mockResolvedValue([]);

    const response = await GET(getRequest());

    expect(response.status).toBe(200);

    // ADMISSION IS UNCHANGED BY W-D2 AND THIS CASE STILL PROVES IT: all eight
    // reader roles are still let through the gate, board is still refused
    // below, and COACHING_CONTENT_READER_ROLES was not edited. What W-D2
    // changed is which READ an admitted caller reaches -- an athlete gets the
    // promoted-only, athlete-safe library; everyone else gets the corpus they
    // always got. Asserting the branch here rather than only in the athlete
    // cases keeps the two halves of the partition visible in one place.
    //
    // W-D4C's lifecycle read does NOT follow this athlete/non-athlete line: it
    // is an author read, which cuts the admitted roles three and five rather
    // than one and seven. It is swept on its own partition in the block
    // "only the authoring roles receive the lifecycle" below.
    if (role === 'athlete') {
      expect(mockAthleteList).toHaveBeenCalledWith('org-1');
      expect(mockList).not.toHaveBeenCalled();
    } else {
      expect(mockList).toHaveBeenCalledWith('org-1', expect.any(Object));
      expect(mockAthleteList).not.toHaveBeenCalled();
    }
  });

  it.each(DENIED_ROLES)('%s is refused, and the read never runs', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal(role));
    mockList.mockResolvedValue([]);

    const response = await GET(getRequest());

    expect(response.status).toBe(403);
    // The status alone would pass if the gate ran AFTER the query. A refusal
    // that has already read the library is not a refusal.
    expect(mockList).not.toHaveBeenCalled();
    expect(mockLifecycles).not.toHaveBeenCalled();
  });

  it('refuses the board on the detail path too, not only the list', async () => {
    // Two reads live behind this one gate and only one of them is a list. A
    // gate placed inside the list branch would satisfy every case above.
    mockRequirePrincipal.mockResolvedValue(principal('board'));
    mockDetail.mockResolvedValue({ drill_id: 'drl-9' });

    const response = await GET(getRequest('drill_id=drl-9'));

    expect(response.status).toBe(403);
    expect(mockDetail).not.toHaveBeenCalled();
    expect(mockLifecycles).not.toHaveBeenCalled();
  });

  it('admits the platform owner, which this route already did, and refuses the board, which it did not', async () => {
    // Stated as its own case because these two ARE the change. Before the
    // decision this route admitted both; /api/pilot/drills refused both. The
    // outcome is neither of those postures, so a reader who assumes it simply
    // adopted the sibling's list would be wrong.
    //
    // It used to assert only that this file's own ADMITTED_ROLES/DENIED_ROLES
    // literals held those two strings, which is a fact about the test file and
    // not about the route: measured, it stayed green both when the policy was
    // mutated to admit board and when it was mutated to drop platform_owner --
    // the two changes it is named after. It calls the route now.
    mockRequirePrincipal.mockResolvedValue(principal('platform_owner'));
    mockList.mockResolvedValue([]);
    expect((await GET(getRequest())).status).toBe(200);
    expect(mockList).toHaveBeenCalledWith('org-1', expect.any(Object));

    jest.clearAllMocks();

    mockRequirePrincipal.mockResolvedValue(principal('board'));
    mockList.mockResolvedValue([]);
    expect((await GET(getRequest())).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();

    // And the partition above agrees, so the sweeps really do cover both sides.
    expect(ADMITTED_ROLES).toContain('platform_owner');
    expect(DENIED_ROLES).toContain('board');
  });

  it('gates on the shared policy rather than a list of its own', () => {
    // The mechanism, not just the outcome. A local literal that happened to
    // hold the same eight roles would satisfy every case above while
    // reintroducing the exact defect the decision resolved: one question,
    // answered separately in each file, free to drift.
    const source = fs.readFileSync(path.join(__dirname, 'route.ts'), 'utf8');
    expect(source).toMatch(/requireRole\(principal, \[\.\.\.COACHING_CONTENT_READER_ROLES\]\)/);
    expect(source).toMatch(
      /import \{ COACHING_CONTENT_READER_ROLES \} from '@\/src\/server\/pilot\/coachingContentAccess'/,
    );
  });
});

describe('the reads it performs are organization-scoped', () => {
  it('lists only the caller organization, with filters passed through', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockList.mockResolvedValue([{ drill_id: 'drl-1' }]);

    const response = await GET(getRequest('discipline=boxing&category=defense'));

    expect(response.status).toBe(200);
    // W-D4C put `lifecycle` beside `drills`; the rows themselves are untouched,
    // which is what this equality still pins. The lifecycle content is asserted
    // in its own block below.
    expect(await response.json()).toEqual({ drills: [{ drill_id: 'drl-1' }], lifecycle: {} });
    expect(mockList).toHaveBeenCalledWith('org-1', {
      discipline: 'boxing',
      category: 'defense',
      difficulty: undefined,
      skillId: undefined,
      relatedSkillId: undefined,
      familyId: undefined,
    });
  });

  it('passes related_skill_id separately from skill_id, so the primary-owner filter keeps its meaning', async () => {
    // The two parameters are different questions and the route must not merge
    // them. skill_id asks who OWNS the drill; related_skill_id asks which drills
    // TRAIN the skill, owner or not. A route that fed one value into both, or
    // widened skill_id in place, would pass a laxer assertion than this one
    // while silently changing what every existing skill_id caller receives.
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockList.mockResolvedValue([]);

    await GET(getRequest('related_skill_id=SK-STANCE-01'));

    expect(mockList).toHaveBeenCalledWith('org-1', {
      discipline: undefined,
      category: undefined,
      difficulty: undefined,
      skillId: undefined,
      relatedSkillId: 'SK-STANCE-01',
      familyId: undefined,
    });

    mockList.mockClear();
    await GET(getRequest('skill_id=SK-COMBO-03'));

    expect(mockList).toHaveBeenCalledWith('org-1', {
      discipline: undefined,
      category: undefined,
      difficulty: undefined,
      skillId: 'SK-COMBO-03',
      relatedSkillId: undefined,
      familyId: undefined,
    });
  });

  it('passes family_id as its own parameter, at a different taxonomy level from both skill filters', async () => {
    // Three parameters, three questions. family_id carries a FAMILY id
    // (SKILL-01), not a skill code, and the route must keep it separate from
    // the two code-level filters rather than folding it into either. A route
    // that fed SKILL-01 into relatedSkillId would satisfy a looser assertion
    // than this while comparing a family id directly against a skill column --
    // the exact level-mixing the design forbids.
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockList.mockResolvedValue([]);

    await GET(getRequest('family_id=SKILL-01'));

    expect(mockList).toHaveBeenCalledWith('org-1', {
      discipline: undefined,
      category: undefined,
      difficulty: undefined,
      skillId: undefined,
      relatedSkillId: undefined,
      familyId: 'SKILL-01',
    });
  });

  it('surfaces an unreconciled family as a 400, not an empty list', async () => {
    // The refusal has to survive the trip through the route. If jsonError did
    // not recognise the typed error, this would arrive as a 500 with the reason
    // stripped; if the data layer had expanded the family to nothing instead of
    // throwing, it would arrive as a 200 with an empty array -- which reads as
    // "SKILL-07 has no drills" and is false.
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockList.mockImplementation(() => {
      throw new ValidationError(
        'Skill family SKILL-07 (Footwork / Ringcraft) has no approved code crosswalk yet.',
        'SKILL_FAMILY_NOT_RECONCILED',
      );
    });

    const response = await GET(getRequest('family_id=SKILL-07'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Skill family SKILL-07 (Footwork / Ringcraft) has no approved code crosswalk yet.',
      code: 'SKILL_FAMILY_NOT_RECONCILED',
    });
  });

  it('reads one drill detail against the caller organization', async () => {
    // This case used to run as an ATHLETE and assert an unfiltered 200, which
    // is precisely the exposure W-D2 closes: it was the automated record that
    // any athlete session could read any reference drill by id, promoted or
    // not. The organization-scoping claim it makes is still worth keeping, so
    // it is re-pointed at a coach -- the role for which unfiltered detail is
    // still correct -- and the athlete's behaviour is asserted separately below.
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockDetail.mockResolvedValue({ drill_id: 'drl-9' });

    const response = await GET(getRequest('drill_id=drl-9'));

    expect(response.status).toBe(200);
    expect(mockDetail).toHaveBeenCalledWith('org-1', 'drl-9');
  });

  it('ignores an organization supplied in the query, on both read paths', async () => {
    // The assertion above is not enough on its own, and mutation testing is how
    // that surfaced: changing the route to
    // `searchParams.get('org') ?? principal.organizationId` left every other
    // case green, because none of them sent an `org` parameter. A test that
    // only ever passes benign input cannot tell "never reads input" apart from
    // "was not asked to".
    //
    // This matters more than the role question this file otherwise records:
    // whoever may read, they may only read their own gym.
    const hostile = 'org=org-victim&organization_id=org-victim&organizationId=org-victim';

    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockDetail.mockResolvedValue({ drill_id: 'drl-9' });
    await GET(getRequest(`drill_id=drl-9&${hostile}`));
    expect(mockDetail).toHaveBeenCalledWith('org-1', 'drl-9');
    // W-D4C's lifecycle read is a third organization-scoped read on these two
    // paths, and it is held to the same rule: another gym's adoption state is
    // as much another gym's data as its drills are.
    expect(mockLifecycles.mock.calls).toEqual([['org-1', ['drl-9']]]);

    mockLifecycles.mockClear();
    mockList.mockResolvedValue([]);
    await GET(getRequest(hostile));
    expect(mockList).toHaveBeenCalledWith('org-1', expect.any(Object));
    expect(mockLifecycles.mock.calls).toEqual([['org-1']]);
  });

  it('returns 404 for a drill the caller organization does not hold', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockDetail.mockResolvedValue(null);

    const response = await GET(getRequest('drill_id=drl-elsewhere'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'DRILL_NOT_FOUND' });
    // The lifecycle is read only for a drill the gym holds. Reading it first
    // and answering 404 anyway would spend a query on another gym's id -- and a
    // route that later started returning what that query found would have its
    // oracle already wired in.
    expect(mockLifecycles).not.toHaveBeenCalled();
  });

  /**
   * W-D2. The athlete half of this route, under the owner rule of 2026-09-17.
   *
   * The rule is a two-sided AND evaluated in SQL -- active reference AND active
   * same-org promotion -- so these cases prove the ROUTING and the SHAPE, and
   * drillLibraryV3.pg.test.ts proves the predicate against a real database.
   * Mocking the query here and asserting the filter "works" would be asserting
   * the mock.
   */
  describe('an athlete reads the adopted library, not the corpus', () => {
    it('lists through the promoted-only, athlete-safe read and answers under `drills`', async () => {
      mockRequirePrincipal.mockResolvedValue(principal('athlete'));
      mockAthleteList.mockResolvedValue([
        {
          drill_id: 'drl-9',
          name: 'Catch and Return',
          purpose: 'Catching the straight punch',
          setup: 'none',
          execution: 'Partner leads, you catch and return.',
          contact_level: 'light',
          requires_coach_authorization: false,
          cues: ['Hand home first'],
        },
      ]);

      const response = await GET(getRequest());

      expect(response.status).toBe(200);
      expect(mockAthleteList).toHaveBeenCalledWith('org-1');
      expect(mockList).not.toHaveBeenCalled();
      const body = await response.json();
      expect(body).toEqual({
        drills: [expect.objectContaining({ drill_id: 'drl-9', setup: 'none' })],
      });
      // W-D4C. Lifecycle and adoption are how the gym governs its library,
      // not instruction -- the athlete answer carries no such key and the
      // read behind it never runs. Keys asserted directly: toEqual ignores an
      // undefined-valued property, and "not called" alone would pass a route
      // that attached a lifecycle it had fetched some other way.
      expect(Object.keys(body)).toEqual(['drills']);
      expect(mockLifecycles).not.toHaveBeenCalled();
    });

    it('does not let a planning filter reach the athlete read', async () => {
      // The coach list takes discipline/category/difficulty and three skill
      // parameters. None of those values appears in the athlete projection, so
      // an athlete could not use them meaningfully; what matters here is the
      // stronger claim that they cannot be used to WIDEN the read either --
      // the athlete read takes the organization and nothing else.
      mockRequirePrincipal.mockResolvedValue(principal('athlete'));
      mockAthleteList.mockResolvedValue([]);

      await GET(getRequest('discipline=boxing&category=defense&skill_id=SK-GUARD-02&family_id=SKILL-07'));

      expect(mockAthleteList).toHaveBeenCalledWith('org-1');
      expect(mockAthleteList).toHaveBeenCalledTimes(1);
    });

    it('reads detail through the promoted-only, athlete-safe read', async () => {
      mockRequirePrincipal.mockResolvedValue(principal('athlete'));
      mockAthleteDetail.mockResolvedValue({ drill_id: 'drl-9', name: 'Catch and Return' });

      const response = await GET(getRequest('drill_id=drl-9'));

      expect(response.status).toBe(200);
      expect(mockAthleteDetail).toHaveBeenCalledWith('org-1', 'drl-9');
      expect(mockDetail).not.toHaveBeenCalled();
      // W-D4C: the staff detail gained `lifecycle`; this one did not.
      const body = await response.json();
      expect(body).toEqual({ drill: { drill_id: 'drl-9', name: 'Catch and Return' } });
      expect(Object.keys(body)).toEqual(['drill']);
      expect(mockLifecycles).not.toHaveBeenCalled();
    });

    it('answers a reference this gym has not adopted exactly like one that does not exist', async () => {
      // getAthleteDrillDetail returns null for four different reasons -- not
      // promoted, promotion retired, reference retracted, another gym's drill.
      // They must be indistinguishable from here, or the 404 becomes an oracle
      // for what exists in a corpus the athlete is not entitled to enumerate.
      mockRequirePrincipal.mockResolvedValue(principal('athlete'));
      mockAthleteDetail.mockResolvedValue(null);

      const response = await GET(getRequest('drill_id=drl-unpromoted'));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'DRILL_NOT_FOUND' });
      expect(mockLifecycles).not.toHaveBeenCalled();
    });

    it('takes the organization from the session, never from the request', async () => {
      const hostile = 'org=org-victim&organization_id=org-victim&organizationId=org-victim';

      mockRequirePrincipal.mockResolvedValue(principal('athlete'));
      mockAthleteList.mockResolvedValue([]);
      await GET(getRequest(hostile));
      expect(mockAthleteList).toHaveBeenCalledWith('org-1');

      mockAthleteDetail.mockResolvedValue({ drill_id: 'drl-9' });
      await GET(getRequest(`drill_id=drl-9&${hostile}`));
      expect(mockAthleteDetail).toHaveBeenCalledWith('org-1', 'drl-9');
      expect(mockLifecycles).not.toHaveBeenCalled();
    });
  });

  it('refuses an unauthenticated caller', async () => {
    mockRequirePrincipal.mockRejectedValue(new Error('Unauthorized'));

    const response = await GET(getRequest());

    expect(response.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
    expect(mockLifecycles).not.toHaveBeenCalled();
  });
});

/**
 * W-D4C, OD-2026-09-19-001 LIFECYCLE. Author reads (coach, organization_admin,
 * admin -- AUTHOR_ROLES; every other reader is swept in the block after this
 * one) now say where each reference drill stands in THIS gym -- available,
 * operational, retired, superseded, unavailable -- and which adopted drill
 * Retire and Restore act on. The coach
 * page's Promote/Retire/Restore decision surface reads it from here and
 * nowhere else (its old include_retired census is gone).
 *
 * The state itself is derived in SQL from durable rows, so these cases prove
 * the WIRING and the SHAPE -- which organization is asked, which ids, and that
 * the answer reaches the response unaltered and in the right place. Whether
 * 'retired' really means "rows point at it, none active" is a question for the
 * database, not for a mock of it.
 */
describe('staff reads carry where each reference stands in this gym (W-D4C)', () => {
  const OPERATIONAL: ReferenceLifecycle = { state: 'operational', operational_drill_id: 'op-9-v2' };
  const RETIRED: ReferenceLifecycle = { state: 'retired', operational_drill_id: 'op-4-v1' };
  const AVAILABLE: ReferenceLifecycle = { state: 'available', operational_drill_id: null };

  it('answers the list with the lifecycle map beside the rows, exactly as the data layer returned it', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockList.mockResolvedValue([{ drill_id: 'drl-9' }, { drill_id: 'drl-4' }]);
    mockLifecycles.mockResolvedValue({ 'drl-9': OPERATIONAL, 'drl-4': RETIRED, 'drl-1': AVAILABLE });

    const response = await GET(getRequest());

    expect(response.status).toBe(200);
    // Beside, not inside: each row keeps the shape every existing consumer of
    // `drills` reads. And keyed by REFERENCE drill id, which is what the page
    // looks rows up by -- operational_drill_id is a different identity and
    // rides inside the value.
    expect(await response.json()).toEqual({
      drills: [{ drill_id: 'drl-9' }, { drill_id: 'drl-4' }],
      lifecycle: { 'drl-9': OPERATIONAL, 'drl-4': RETIRED, 'drl-1': AVAILABLE },
    });
  });

  it('asks for the list lifecycle by the session organization alone, whatever the filters', async () => {
    // One argument, and it is the principal's. No id list: the map is the
    // gym's standing across its reference corpus, not narrowed to whichever
    // rows a filter happened to return. And the filters, which DO narrow the
    // rows, do not leak into it -- listDrillLibrary's own filter object is
    // pinned exactly in the block above.
    mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
    mockList.mockResolvedValue([]);

    await GET(
      getRequest('discipline=boxing&category=defense&difficulty=beginner&skill_id=SK-GUARD-02&family_id=SKILL-01'),
    );

    expect(mockLifecycles.mock.calls).toEqual([['org-1']]);
  });

  it('answers staff detail with the lifecycle of this drill, read for this drill id only', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockDetail.mockResolvedValue({ drill_id: 'drl-9', name: 'Catch and Return' });
    // The map carries a neighbour on purpose. A route that returned the whole
    // map, or the first entry, instead of the one it was asked about would
    // satisfy a map holding only drl-9.
    mockLifecycles.mockResolvedValue({ 'drl-4': RETIRED, 'drl-9': OPERATIONAL });

    const response = await GET(getRequest('drill_id=drl-9'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      drill: { drill_id: 'drl-9', name: 'Catch and Return' },
      lifecycle: OPERATIONAL,
    });
    expect(mockLifecycles.mock.calls).toEqual([['org-1', ['drl-9']]]);
  });

  it.each<ReferenceLifecycle>([
    { state: 'available', operational_drill_id: null },
    { state: 'operational', operational_drill_id: 'op-9-v3' },
    { state: 'retired', operational_drill_id: 'op-9-v3' },
    { state: 'superseded', operational_drill_id: null },
    { state: 'unavailable', operational_drill_id: null },
  ])('passes the $state state through the detail untouched', async (lifecycle) => {
    // Every state reaches the page as the data layer said it. The route owns
    // no mapping of its own -- a route that collapsed 'retired' into
    // 'unavailable', or dropped operational_drill_id, would leave the page
    // offering the wrong action or none.
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockDetail.mockResolvedValue({ drill_id: 'drl-9' });
    mockLifecycles.mockResolvedValue({ 'drl-9': lifecycle });

    const response = await GET(getRequest('drill_id=drl-9'));

    expect((await response.json()).lifecycle).toEqual(lifecycle);
  });

  it('answers a detail whose lifecycle was not found with an explicit null, not a missing key', async () => {
    // The page reads a null lifecycle as "status could not be read" and offers
    // no action. An omitted key would be indistinguishable, over JSON, from a
    // route that never sent one -- which is what the athlete branch does.
    mockRequirePrincipal.mockResolvedValue(principal('coach'));
    mockDetail.mockResolvedValue({ drill_id: 'drl-9' });
    mockLifecycles.mockResolvedValue({ 'drl-4': RETIRED });

    const response = await GET(getRequest('drill_id=drl-9'));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body).sort()).toEqual(['drill', 'lifecycle']);
    expect(body.lifecycle).toBeNull();
  });
});

/**
 * W-D4C, round-1 repair R3. The lifecycle map was first attached to every
 * non-athlete read, which handed a gym's retire/restore governance to parents,
 * volunteers, staff and the platform owner -- none of whom can act on it. It is
 * now an AUTHOR read, and this block is the sweep that says so role by role.
 *
 * Both halves are swept in full, not sampled: a branch keyed on the wrong role
 * (athlete-only, as before the repair; or one author dropped) passes any case
 * that happens to pick a role on the right side of the mistake.
 *
 * Key lists are asserted with Object.keys rather than toEqual alone, because
 * toEqual ignores an undefined-valued property, and "never called" is asserted
 * separately from the shape because a route could read the lifecycle and then
 * decline to attach it -- spending another gym-governance query on a caller
 * with no business asking it.
 */
describe('only the authoring roles receive the lifecycle (W-D4C)', () => {
  const HOSTILE = 'org=org-victim&organization_id=org-victim&organizationId=org-victim';
  const OPERATIONAL: ReferenceLifecycle = { state: 'operational', operational_drill_id: 'op-9-v2' };
  const RETIRED: ReferenceLifecycle = { state: 'retired', operational_drill_id: 'op-4-v1' };
  const MAP: Record<string, ReferenceLifecycle> = { 'drl-9': OPERATIONAL, 'drl-4': RETIRED };

  // A session organization no other case uses, so an assertion on it cannot
  // be satisfied by a literal 'org-1' somewhere in the route or the helper.
  function sessionOf(role: PilotRole): PilotPrincipal {
    return { ...principal(role), organizationId: 'org-session-7' };
  }

  beforeEach(() => {
    // A NON-EMPTY map for every case in this block, readers included: if the
    // route attached it where it should not, the key list below would show it.
    mockLifecycles.mockResolvedValue(MAP);
    mockList.mockResolvedValue([{ drill_id: 'drl-9' }]);
    mockAthleteList.mockResolvedValue([{ drill_id: 'drl-9' }]);
    mockDetail.mockResolvedValue({ drill_id: 'drl-9', name: 'Catch and Return' });
    mockAthleteDetail.mockResolvedValue({ drill_id: 'drl-9', name: 'Catch and Return' });
  });

  it('classifies every role in the vocabulary on one side of the author line, or refuses it', () => {
    // Parsed out of contracts.ts, like the partition above. A tenth role added
    // to PilotRole appears in neither list and fails here, rather than landing
    // on whichever side of the route's comparison it happens to fall.
    expect([...AUTHOR_ROLES, ...PLAIN_READER_ROLES, ...DENIED_ROLES].sort()).toEqual([...ALL_ROLES].sort());
    // And the author line splits the admitted roles exactly -- no role both
    // reads the lifecycle and is swept as a plain reader.
    expect([...AUTHOR_ROLES, ...PLAIN_READER_ROLES].sort()).toEqual([...ADMITTED_ROLES].sort());
  });

  describe.each(AUTHOR_ROLES)('%s (an author)', (role) => {
    it('lists with the lifecycle beside the rows, read for the session organization alone', async () => {
      mockRequirePrincipal.mockResolvedValue(sessionOf(role));

      const response = await GET(getRequest(HOSTILE));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Object.keys(body)).toEqual(['drills', 'lifecycle']);
      expect(body).toEqual({ drills: [{ drill_id: 'drl-9' }], lifecycle: MAP });
      expect(mockLifecycles.mock.calls).toEqual([['org-session-7']]);
    });

    it('reads detail with this drill\'s lifecycle, asked for this drill id in the session organization', async () => {
      mockRequirePrincipal.mockResolvedValue(sessionOf(role));

      const response = await GET(getRequest(`drill_id=drl-9&${HOSTILE}`));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Object.keys(body)).toEqual(['drill', 'lifecycle']);
      expect(body).toEqual({ drill: { drill_id: 'drl-9', name: 'Catch and Return' }, lifecycle: OPERATIONAL });
      expect(mockDetail).toHaveBeenCalledWith('org-session-7', 'drl-9');
      expect(mockLifecycles.mock.calls).toEqual([['org-session-7', ['drl-9']]]);
    });
  });

  describe.each(PLAIN_READER_ROLES)('%s (not an author)', (role) => {
    it('lists in the shape it had before W-D4C, and the lifecycle is never read', async () => {
      mockRequirePrincipal.mockResolvedValue(sessionOf(role));

      const response = await GET(getRequest(HOSTILE));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Object.keys(body)).toEqual(['drills']);
      expect(body).toEqual({ drills: [{ drill_id: 'drl-9' }] });
      expect(mockLifecycles).not.toHaveBeenCalled();
      // Still the read this role always reached -- the repair moved the
      // lifecycle, not the library.
      if (role === 'athlete') {
        expect(mockAthleteList).toHaveBeenCalledWith('org-session-7');
        expect(mockList).not.toHaveBeenCalled();
      } else {
        expect(mockList).toHaveBeenCalledWith('org-session-7', expect.any(Object));
        expect(mockAthleteList).not.toHaveBeenCalled();
      }
    });

    it('reads detail in the shape it had before W-D4C, and the lifecycle is never read', async () => {
      mockRequirePrincipal.mockResolvedValue(sessionOf(role));

      const response = await GET(getRequest(`drill_id=drl-9&${HOSTILE}`));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Object.keys(body)).toEqual(['drill']);
      expect(body).toEqual({ drill: { drill_id: 'drl-9', name: 'Catch and Return' } });
      expect(mockLifecycles).not.toHaveBeenCalled();
      if (role === 'athlete') {
        expect(mockAthleteDetail).toHaveBeenCalledWith('org-session-7', 'drl-9');
        expect(mockDetail).not.toHaveBeenCalled();
      } else {
        expect(mockDetail).toHaveBeenCalledWith('org-session-7', 'drl-9');
        expect(mockAthleteDetail).not.toHaveBeenCalled();
      }
    });
  });

  it.each(DENIED_ROLES)('%s is still refused on both paths, before any read', async (role) => {
    mockRequirePrincipal.mockResolvedValue(sessionOf(role));

    expect((await GET(getRequest())).status).toBe(403);
    expect((await GET(getRequest('drill_id=drl-9'))).status).toBe(403);

    expect(mockList).not.toHaveBeenCalled();
    expect(mockDetail).not.toHaveBeenCalled();
    expect(mockAthleteList).not.toHaveBeenCalled();
    expect(mockAthleteDetail).not.toHaveBeenCalled();
    expect(mockLifecycles).not.toHaveBeenCalled();
  });
});
