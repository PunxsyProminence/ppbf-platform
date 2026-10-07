import { NextRequest } from 'next/server';

import { POST } from './route';
import {
  getDrillWithDetail,
  getOtherVersionAdoption,
  listReferenceLifecycles,
} from '@/src/server/pilot/drillLibraryV3';
import {
  DrillNameTakenError,
  ReferenceDrillAlreadyPromotedError,
  promoteReferenceDrill,
} from '@/src/server/pilot/drills';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { listFloorValidations } from '@/src/server/pilot/drillFloorValidations';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

// Promotion is the only bridge between the two drill models, so the cases that
// matter are the ones that decide WHICH model a row ends up in and WHOSE gym it
// belongs to. Everything is mocked except the route: this suite is about the
// route's contract, and the schema half is proven against real PostgreSQL in
// drillReferenceProvenance.pg.test.ts.
//
// adoptionReadiness (src/lib/drillAdoptionReadiness.ts) is deliberately NOT
// mocked. It is pure, and the route is where it is enforced, so the cases below
// prove the real check runs on the server and that its answer reaches the
// caller word for word.

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/drillLibraryV3', () => ({
  getDrillWithDetail: jest.fn(),
  getOtherVersionAdoption: jest.fn(),
  listReferenceLifecycles: jest.fn(),
}));

jest.mock('@/src/server/pilot/drills', () => {
  const actual = jest.requireActual('@/src/server/pilot/drills');
  return { ...actual, promoteReferenceDrill: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/drillFloorValidations', () => ({
  listFloorValidations: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetReference = getDrillWithDetail as jest.Mock;
const mockLifecycles = listReferenceLifecycles as jest.Mock;
const mockOtherVersion = getOtherVersionAdoption as jest.Mock;
const mockPromote = promoteReferenceDrill as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;
const mockFloorTested = listFloorValidations as jest.Mock;

const REFERENCE_ID = 'drl_reference_1';
const LITERATURE_DRAFT =
  'LITERATURE-GROUNDED DRAFT — generated from cited registry claims; REQUIRES FLOOR VALIDATION';
const CRAFT_DRAFT = 'COACHING-CRAFT DRAFT — no directly relevant research retrieved; REQUIRES FLOOR VALIDATION';

// The route's refusals, word for word. Asserted exactly rather than by pattern
// because each one names a different remedy for the coach.
const RETRACTED_MESSAGE = 'This reference drill is retracted and cannot be promoted.';
const ALREADY_PROMOTED_MESSAGE = 'This reference drill has already been promoted into this gym.';
const RESTORE_INSTEAD_MESSAGE =
  'This gym adopted this reference drill before and then retired it. Restore that drill instead of promoting it again.';
const NOT_READY_MESSAGE = 'This reference drill is not ready to adopt.';
const SCALING_INCOMPLETE =
  'Its scaling is incomplete: it needs easier, standard and harder levels, with one marked as the starting point.';
const NEWER_VERSION_MESSAGE =
  "This gym already has an earlier version of this drill. Updating the gym's drill to this newer version is not built yet, so this version cannot be promoted as a separate drill.";

function principal(overrides: Partial<PilotPrincipal> = {}): PilotPrincipal {
  return {
    accountId: 'coach-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

function scaleLevel(scaleLevel: 'A' | 'B' | 'C', isStartingPoint = false) {
  return {
    scale_level: scaleLevel,
    is_starting_point: isStartingPoint,
    demand_description: `Level ${scaleLevel}`,
  };
}

// A READY reference drill: the fields promotion reads, plus the ones adoption
// readiness checks -- current (active, not superseded), named, with a purpose,
// category and difficulty, a setup, an execution, what good looks like, the
// A/B/C scale with exactly one starting point, and at least one stop rule. The
// reference row carries far more, and the point of naming just these is that
// the rest stays on pilot.drill_library.
function referenceDrill(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    drill_id: REFERENCE_ID,
    superseded_at: null,
    name: 'Cross Return to Guard',
    discipline: 'boxing',
    category: 'technical',
    difficulty: 'intermediate',
    purpose: 'Return the rear hand to guard immediately after the cross.',
    target_behavior: 'Hand returns before the next punch starts.',
    standard_setup: 'Partners at technical distance.',
    execution: 'On the call, throw the cross and bring the rear hand home before the next call.',
    what_good_looks_like: 'The rear hand is back at the cheek before the next punch leaves.',
    requires_coach_authorization: false,
    active: true,
    cues: [
      { cue_id: 'cue-1', cue_text: 'Chin behind the shoulder' },
      { cue_id: 'cue-2', cue_text: 'Hand home first' },
    ],
    scale_levels: [scaleLevel('A'), scaleLevel('B', true), scaleLevel('C')],
    stop_rules: [{ ordinal: 1, condition_text: 'Stop on any head contact' }],
    secondary_skills: [{ skill_id: 'SK-GUARD-02' }],
    ...overrides,
  };
}

function promotedDrill(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    drill_id: 'operational-1',
    reference_drill_id: REFERENCE_ID,
    name: 'Cross Return to Guard',
    category: 'technical',
    focus: 'Return the rear hand to guard immediately after the cross.',
    cues: ['Chin behind the shoulder', 'Hand home first'],
    difficulty: 'intermediate',
    active: true,
    created_at: '2026-09-16T00:00:00.000Z',
    updated_at: '2026-09-16T00:00:00.000Z',
    ...overrides,
  };
}

// listReferenceLifecycles' shape for the one reference this suite promotes.
function lifecycleFor(state: string, operationalDrillId: string | null = 'operational-1') {
  return { [REFERENCE_ID]: { state, operational_drill_id: operationalDrillId } };
}

function promoteRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/drills/promote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockGetReference.mockResolvedValue(referenceDrill());
  // No floor-tested mark in this gym unless a case says so; the fixture's
  // provenance is the source manual, which needs none.
  mockFloorTested.mockResolvedValue({});
  // An already-promoted conflict in a live gym means the reference is adopted:
  // operational unless the coach retired it. Tests that need another answer
  // say so.
  mockLifecycles.mockResolvedValue(lifecycleFor('operational'));
  // The gym has no other version of this reference's lineage unless a test
  // says so.
  mockOtherVersion.mockResolvedValue(null);
  mockPromote.mockResolvedValue(promotedDrill());
  mockAudit.mockResolvedValue(undefined);
});

describe('who may promote', () => {
  // Promotion writes an assignable drill, so it is the AUTHOR list's question,
  // not the reader policy's. platform_owner reads coaching content and is
  // deliberately still refused here: reading a gym's drills is not authoring in
  // one.
  it.each(['coach', 'organization_admin', 'admin'])('allows %s', async (role) => {
    mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(201);
    expect(mockPromote).toHaveBeenCalledTimes(1);
  });

  it.each(['athlete', 'parent', 'volunteer', 'staff', 'platform_owner', 'board'])(
    'refuses %s',
    async (role) => {
      mockRequirePrincipal.mockResolvedValue(principal({ role: role as PilotPrincipal['role'] }));

      const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

      expect(response.status).toBe(403);
      expect(mockPromote).not.toHaveBeenCalled();
    },
  );

  it('refuses an unauthenticated caller', async () => {
    mockRequirePrincipal.mockRejectedValue(
      Object.assign(new Error('Unauthorized'), { status: 401 }),
    );

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(401);
    expect(mockPromote).not.toHaveBeenCalled();
  });
});

describe('which gym the promotion lands in', () => {
  it('reads the reference drill under the session organization and ignores a supplied one', async () => {
    const response = await POST(
      promoteRequest({ reference_drill_id: REFERENCE_ID, organization_id: 'org-somebody-else' }),
    );

    expect(response.status).toBe(201);
    expect(mockGetReference).toHaveBeenCalledWith('org-1', REFERENCE_ID);
    expect(mockPromote).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-1' }));
  });

  it('answers a reference drill from another gym as not found, revealing nothing', async () => {
    // getDrillWithDetail is organization-scoped, so a foreign id reads as absent.
    mockGetReference.mockResolvedValue(null);

    const response = await POST(promoteRequest({ reference_drill_id: 'drl_other_gym' }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it('requires a reference_drill_id', async () => {
    const response = await POST(promoteRequest({}));

    expect(response.status).toBe(400);
    expect(mockPromote).not.toHaveBeenCalled();
  });
});

describe('what promotion copies', () => {
  it('carries the exact reference id and maps name, category, difficulty and focus from purpose', async () => {
    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(201);
    expect(mockPromote).toHaveBeenCalledWith({
      organizationId: 'org-1',
      referenceDrillId: REFERENCE_ID,
      name: 'Cross Return to Guard',
      category: 'technical',
      difficulty: 'intermediate',
      // focus is the operational field the coach surface labels "What it is
      // for"; purpose is the reference field holding that same meaning.
      focus: 'Return the rear hand to guard immediately after the cross.',
      cues: ['Chin behind the shoulder', 'Hand home first'],
    });
  });

  it('copies cue text only, and never the reference metadata that stays canonical on the library', async () => {
    await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    const [params] = mockPromote.mock.calls[0] as [Record<string, unknown>];
    expect(params.cues).toEqual(['Chin behind the shoulder', 'Hand home first']);
    for (const field of [
      'source_ref',
      'field_provenance',
      'grounding_claim_ids',
      'created_by_account_id',
      'created_by_role',
      'stop_rules',
      'scale_levels',
      'secondary_skills',
      'requires_coach_authorization',
      'contact_level',
    ]) {
      expect(params).not.toHaveProperty(field);
    }
  });

  it('respects the operational cue ceiling of twelve', async () => {
    mockGetReference.mockResolvedValue(
      referenceDrill({
        cues: Array.from({ length: 15 }, (_, index) => ({
          cue_id: `cue-${index}`,
          cue_text: `Cue ${index}`,
        })),
      }),
    );

    await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    const [params] = mockPromote.mock.calls[0] as [{ cues: string[] }];
    expect(params.cues).toHaveLength(12);
    expect(params.cues[0]).toBe('Cue 0');
  });

  it('refuses a reference difficulty the operational vocabulary does not carry', async () => {
    mockGetReference.mockResolvedValue(referenceDrill({ difficulty: 'fundamentals' }));

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(400);
    expect(mockPromote).not.toHaveBeenCalled();
  });
});

describe('what promotion refuses', () => {
  it('refuses a retracted reference drill, which cannot be newly promoted', async () => {
    mockGetReference.mockResolvedValue(referenceDrill({ active: false }));

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(409);
    expect(String((await response.json()).error)).toMatch(/retract/i);
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it('answers a retracted reference with the retracted refusal before judging its readiness', async () => {
    // This reference would also fail readiness three ways. The retraction is
    // checked first and answered in its own words, so the coach is told the
    // drill is gone -- not handed a list of content to fix on a drill that can
    // never be adopted.
    mockGetReference.mockResolvedValue(
      referenceDrill({
        active: false,
        superseded_at: '2026-09-18T00:00:00.000Z',
        standard_setup: '',
        stop_rules: [],
      }),
    );

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: RETRACTED_MESSAGE });
    expect(mockPromote).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('reports a second promotion of the same reference drill as its own conflict', async () => {
    // Not the name collision below: the two failures have different remedies,
    // so they must not arrive as one message.
    mockPromote.mockRejectedValue(new ReferenceDrillAlreadyPromotedError(REFERENCE_ID));

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(409);
    expect(String((await response.json()).error)).toMatch(/already been promoted/i);
  });

  it('reports an existing operational name collision as the name collision it is', async () => {
    mockPromote.mockRejectedValue(new DrillNameTakenError('Cross Return to Guard'));

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(409);
    expect(String((await response.json()).error)).toMatch(/already has a drill named/i);
  });

  it('does not write audit evidence when the promotion failed', async () => {
    mockPromote.mockRejectedValue(new ReferenceDrillAlreadyPromotedError(REFERENCE_ID));

    await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(mockAudit).not.toHaveBeenCalled();
  });
});

describe('adoption readiness', () => {
  // Enforced on the server so neither the coach page nor a direct API call can
  // adopt a drill missing what it needs to run. Each case breaks exactly one
  // requirement of the ready fixture, so the missing list must name that one
  // requirement and nothing else.
  const NOT_READY_CASES: [string, Record<string, unknown>, string[]][] = [
    ['a blank name', { name: '   ' }, ['It has no name.']],
    ['no purpose', { purpose: '' }, ['It does not say what it is for.']],
    ['no category', { category: '' }, ['It has no category.']],
    // Answered as not-ready (409), not as the unsupported-difficulty 400: the
    // readiness check runs first and names what the coach is looking at.
    ['no difficulty', { difficulty: '' }, ['It has no difficulty.']],
    ['no setup', { standard_setup: '' }, ['It has no setup.']],
    ['no execution', { execution: '  ' }, ['It does not say how it runs.']],
    ['no description of good execution', { what_good_looks_like: '' }, ['It does not say what good execution looks like.']],
    ['no scale levels at all', { scale_levels: [] }, [SCALING_INCOMPLETE]],
    ['no easier level', { scale_levels: [scaleLevel('B', true), scaleLevel('C')] }, [SCALING_INCOMPLETE]],
    ['no standard level', { scale_levels: [scaleLevel('A', true), scaleLevel('C')] }, [SCALING_INCOMPLETE]],
    ['no harder level', { scale_levels: [scaleLevel('A'), scaleLevel('B', true)] }, [SCALING_INCOMPLETE]],
    [
      'no level marked as the starting point',
      { scale_levels: [scaleLevel('A'), scaleLevel('B'), scaleLevel('C')] },
      [SCALING_INCOMPLETE],
    ],
    [
      'two levels marked as the starting point',
      { scale_levels: [scaleLevel('A', true), scaleLevel('B', true), scaleLevel('C')] },
      [SCALING_INCOMPLETE],
    ],
    ['no stop rules', { stop_rules: [] }, ['It has no stop rules.']],
  ];

  it.each(NOT_READY_CASES)(
    'refuses a reference with %s as not ready, naming exactly what is missing',
    async (_label, overrides, missing) => {
      mockGetReference.mockResolvedValue(referenceDrill(overrides));

      const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: NOT_READY_MESSAGE,
        code: 'NOT_READY_TO_ADOPT',
        missing,
      });
      expect(mockPromote).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
      expect(mockLifecycles).not.toHaveBeenCalled();
    },
  );

  it('refuses a superseded reference drill as not ready, not as retracted', async () => {
    // A superseded version is still active -- history stays readable -- but a
    // newer version exists, and that is the one a gym adopts.
    mockGetReference.mockResolvedValue(
      referenceDrill({ active: true, superseded_at: '2026-09-18T00:00:00.000Z' }),
    );

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: NOT_READY_MESSAGE,
      code: 'NOT_READY_TO_ADOPT',
      missing: ['A newer version of this reference drill exists.'],
    });
    expect(mockPromote).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('names every unmet requirement at once, in the fixed order', async () => {
    mockGetReference.mockResolvedValue(
      referenceDrill({
        superseded_at: '2026-09-18T00:00:00.000Z',
        standard_setup: '',
        scale_levels: [scaleLevel('B', true)],
        stop_rules: [],
      }),
    );

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: NOT_READY_MESSAGE,
      code: 'NOT_READY_TO_ADOPT',
      missing: [
        'A newer version of this reference drill exists.',
        'It has no setup.',
        SCALING_INCOMPLETE,
        'It has no stop rules.',
      ],
    });
    expect(mockPromote).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  // OD-2026-10-06-026 ruling 2: a technique drill needs at least one cue
  // before it can be adopted; a conditioning drill does not. (Ruling 3, the
  // floor-tested mark for drafts, has its own cases below.)
  it('refuses a technique drill with no cue, naming the missing cue', async () => {
    mockGetReference.mockResolvedValue(
      referenceDrill({ cues: [], field_provenance: 'PPBF source manual v3' }),
    );

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: NOT_READY_MESSAGE,
      code: 'NOT_READY_TO_ADOPT',
      missing: ['It has no coaching cue. A technique drill needs at least one; a conditioning drill does not.'],
    });
    expect(mockPromote).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('adopts a conditioning drill with no cue (the exemption)', async () => {
    mockGetReference.mockResolvedValue(
      referenceDrill({ discipline: 'conditioning', category: 'strength', cues: [], field_provenance: 'PPBF source manual v3' }),
    );

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(201);
    expect(mockPromote).toHaveBeenCalledWith(expect.objectContaining({ cues: [] }));
  });

  // OD-2026-10-06-026 ruling 3: a draft stays a draft for this gym until one
  // of its coaches marks it floor-tested. The mark is read on the server.
  it('refuses a draft this gym has not floor-tested, naming the missing floor test', async () => {
    mockGetReference.mockResolvedValue(referenceDrill({ field_provenance: LITERATURE_DRAFT }));

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: NOT_READY_MESSAGE,
      code: 'NOT_READY_TO_ADOPT',
      missing: ['It is a draft that requires floor validation, and no coach of this gym has marked it floor-tested.'],
    });
    expect(mockFloorTested).toHaveBeenCalledWith('org-1', [REFERENCE_ID]);
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it('adopts a draft once a coach of this gym has marked it floor-tested', async () => {
    mockGetReference.mockResolvedValue(referenceDrill({ field_provenance: CRAFT_DRAFT }));
    mockFloorTested.mockResolvedValue({
      [REFERENCE_ID]: { validation_id: 'dfv-1', drill_id: REFERENCE_ID, validated_by_account_id: 'coach-2', validated_at: '2026-10-07T00:00:00.000Z' },
    });

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(201);
    expect(mockPromote).toHaveBeenCalled();
  });

  it("another gym's mark does not count: the read is for the session organization", async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-2' }));
    mockGetReference.mockResolvedValue(referenceDrill({ organization_id: 'org-2', field_provenance: LITERATURE_DRAFT }));
    // org-1 has marked this version; org-2 has not. The read answers by the
    // organization it is asked for, as the real query does.
    const mark = { validation_id: 'dfv-1', drill_id: REFERENCE_ID, validated_by_account_id: 'coach-1', validated_at: '2026-10-07T00:00:00.000Z' };
    mockFloorTested.mockImplementation(async (organizationId: string, ids: string[]) =>
      organizationId === 'org-1' && ids.includes(REFERENCE_ID) ? { [REFERENCE_ID]: mark } : {});

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(409);
    expect(mockFloorTested).toHaveBeenCalledWith('org-2', [REFERENCE_ID]);
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it('a cue of only whitespace does not count as a cue', async () => {
    mockGetReference.mockResolvedValue(referenceDrill({ cues: [{ cue_text: '   ' }] }));

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(409);
    expect(mockPromote).not.toHaveBeenCalled();
  });
});

describe('a newer version of a drill this gym already has (owner ruling R2)', () => {
  // A revised drill is v(n+1); the gym's operational drill keeps pointing at
  // the version it adopted. Until the coach-reviewed update step exists
  // (IMP-15), promoting the newer version separately is refused -- a renamed
  // v2 would otherwise become a second operational drill of one lineage.
  const GYM_VERSION = { operational_drill_id: 'operational-v1', adopted_reference_drill_id: 'drl_reference_v1' };

  it('newer version of a lineage the gym runs is refused with guidance', async () => {
    mockOtherVersion.mockResolvedValue(GYM_VERSION);

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: NEWER_VERSION_MESSAGE,
      code: 'NEWER_VERSION_UPDATE_NOT_BUILT',
      operational_drill_id: 'operational-v1',
    });
    expect(mockPromote).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('asks about the session organization and the reference it read, never a supplied organization', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-session' }));
    mockGetReference.mockResolvedValue(referenceDrill({ organization_id: 'org-session' }));
    // Another version is adopted only in the session's gym: the refusal can
    // only come back if the question was asked about it.
    mockOtherVersion.mockImplementation(async (organizationId: string) =>
      organizationId === 'org-session' ? GYM_VERSION : null,
    );

    const response = await POST(
      promoteRequest({ reference_drill_id: REFERENCE_ID, organization_id: 'org-somebody-else' }),
    );

    expect(mockOtherVersion.mock.calls).toEqual([['org-session', REFERENCE_ID]]);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('NEWER_VERSION_UPDATE_NOT_BUILT');
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it('writes nothing when it cannot tell whether the gym has another version', async () => {
    // Failing closed: "could not read" is not "has none", and a promotion on
    // that guess could create the second operational drill this check exists
    // to prevent.
    mockOtherVersion.mockRejectedValue(new Error('connection terminated unexpectedly'));
    // jsonError logs the unhandled error class; expected here, so kept quiet.
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));
    logged.mockRestore();

    expect(response.status).toBe(500);
    expect(mockPromote).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('answers a retracted or not-ready reference in its own words before asking', async () => {
    // Those refusals say something about the reference itself; the other-
    // version question only matters for one the gym could otherwise adopt.
    mockOtherVersion.mockResolvedValue(GYM_VERSION);

    mockGetReference.mockResolvedValueOnce(referenceDrill({ active: false }));
    const retracted = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));
    mockGetReference.mockResolvedValueOnce(referenceDrill({ stop_rules: [] }));
    const notReady = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(await retracted.json()).toEqual({ error: RETRACTED_MESSAGE });
    expect((await notReady.json()).code).toBe('NOT_READY_TO_ADOPT');
    expect(mockOtherVersion).not.toHaveBeenCalled();
    expect(mockPromote).not.toHaveBeenCalled();
  });

  it('promotes as before when the gym has no other version of the lineage', async () => {
    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(201);
    expect(mockOtherVersion.mock.calls).toEqual([['org-1', REFERENCE_ID]]);
    expect(mockPromote).toHaveBeenCalledTimes(1);
  });
});

describe('an already-promoted reference drill, worded by its lifecycle', () => {
  it('tells the coach to restore the retired drill instead of promoting again', async () => {
    mockPromote.mockRejectedValue(new ReferenceDrillAlreadyPromotedError(REFERENCE_ID));
    mockLifecycles.mockResolvedValue(lifecycleFor('retired'));

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: RESTORE_INSTEAD_MESSAGE,
      code: 'PROMOTION_RETIRED_RESTORE_INSTEAD',
    });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it.each(['operational', 'available', 'superseded', 'unavailable'])(
    'keeps the already-promoted refusal when the lifecycle reads %s',
    async (state) => {
      mockPromote.mockRejectedValue(new ReferenceDrillAlreadyPromotedError(REFERENCE_ID));
      mockLifecycles.mockResolvedValue(lifecycleFor(state));

      const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: ALREADY_PROMOTED_MESSAGE });
    },
  );

  it('keeps the already-promoted refusal when the lifecycle has no entry for the reference', async () => {
    mockPromote.mockRejectedValue(new ReferenceDrillAlreadyPromotedError(REFERENCE_ID));
    mockLifecycles.mockResolvedValue({});

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: ALREADY_PROMOTED_MESSAGE });
  });

  it('keeps the already-promoted 409, not a 500, when the lifecycle read fails', async () => {
    // The lifecycle only words the refusal. Losing it must not turn a clear
    // conflict into a server error.
    mockPromote.mockRejectedValue(new ReferenceDrillAlreadyPromotedError(REFERENCE_ID));
    mockLifecycles.mockRejectedValue(new Error('connection terminated unexpectedly'));

    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(mockLifecycles).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: ALREADY_PROMOTED_MESSAGE });
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('reads the lifecycle under the session organization, for that one reference, and ignores a supplied one', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ organizationId: 'org-session' }));
    mockGetReference.mockResolvedValue(referenceDrill({ organization_id: 'org-session' }));
    mockPromote.mockRejectedValue(new ReferenceDrillAlreadyPromotedError(REFERENCE_ID));
    // Retired only in the session's gym: the restore wording can only come back
    // if the read was scoped to it.
    mockLifecycles.mockImplementation(async (organizationId: string) =>
      organizationId === 'org-session' ? lifecycleFor('retired') : {},
    );

    const response = await POST(
      promoteRequest({ reference_drill_id: REFERENCE_ID, organization_id: 'org-somebody-else' }),
    );

    expect(mockLifecycles).toHaveBeenCalledTimes(1);
    expect(mockLifecycles).toHaveBeenCalledWith('org-session', [REFERENCE_ID]);
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('PROMOTION_RETIRED_RESTORE_INSTEAD');
  });

  it('does not read the lifecycle for a name collision or a successful promotion', async () => {
    mockPromote.mockRejectedValueOnce(new DrillNameTakenError('Cross Return to Guard'));

    const collision = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));
    const success = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(collision.status).toBe(409);
    expect(success.status).toBe(201);
    expect(mockLifecycles).not.toHaveBeenCalled();
  });
});

describe('what a successful promotion records', () => {
  it('writes drill creation audit evidence naming the reference it came from', async () => {
    await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'create',
        actor_account_id: 'coach-1',
        actor_role: 'coach',
        organization_id: 'org-1',
        entity_type: 'drill',
        entity_id: 'operational-1',
        details: expect.objectContaining({ reference_drill_id: REFERENCE_ID }),
      }),
    );
  });

  it('answers 201 with the operational drill carrying its reference pointer', async () => {
    const response = await POST(promoteRequest({ reference_drill_id: REFERENCE_ID }));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      ok: true,
      organization_id: 'org-1',
      drill: promotedDrill(),
    });
  });
});
