import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import {
  DrillNameTakenError,
  DrillRestoreRefusedError,
  assertDrillMeetsCueRule,
  createDrill,
  getDrill,
  listDrills,
  updateDrill,
} from '@/src/server/pilot/drills';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { queryOne } from '@/src/server/pilot/db';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/drills', () => {
  const actual = jest.requireActual('@/src/server/pilot/drills');
  return {
    ...actual,
    listDrills: jest.fn(),
    createDrill: jest.fn(),
    getDrill: jest.fn(),
    updateDrill: jest.fn(),
    // The rule itself runs for real (it is pure until it needs the reference
    // drill); only the reference read behind it is stubbed.
    assertDrillMeetsCueRule: jest.fn(actual.assertDrillMeetsCueRule),
  };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(async () => []),
  queryOne: jest.fn(async () => null),
  withTransaction: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockListDrills = listDrills as jest.Mock;
const mockCreateDrill = createDrill as jest.Mock;
const mockUpdateDrill = updateDrill as jest.Mock;
const mockGetDrill = getDrill as jest.Mock;
const mockCueRule = assertDrillMeetsCueRule as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

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

function drill(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    drill_id: 'drill-1',
    name: 'Straight Jab Retraction Snap',
    category: 'Striking',
    focus: 'Quick fist return to protect the chin.',
    cues: ['Elbow tucked'],
    difficulty: 'intermediate',
    active: true,
    reference_drill_id: null,
    created_at: '2026-07-30T12:00:00.000Z',
    updated_at: '2026-07-30T12:00:00.000Z',
    ...overrides,
  };
}

function getRequest(search = '') {
  return new NextRequest(`http://localhost/api/pilot/drills${search}`);
}

function bodyRequest(method: 'POST' | 'PATCH', body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/drills', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mockListDrills.mockResolvedValue([drill()]);
  mockCreateDrill.mockResolvedValue(drill());
  mockUpdateDrill.mockResolvedValue(drill({ active: false }));
  // What the edit route finds before writing: a retired drill that carries a cue.
  mockGetDrill.mockResolvedValue(drill({ active: false }));
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/drills', () => {
  test('rejects an unauthenticated caller', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    const res = await GET(getRequest());

    expect(res.status).toBe(401);
    expect(mockListDrills).not.toHaveBeenCalled();
  });

  // The board sees organization-level aggregates only. Unchanged by the
  // 2026-08-27 decision, which extended this refusal to the two v3 library
  // surfaces rather than relaxing it here.
  test('rejects the board', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'board' }));

    const res = await GET(getRequest());

    expect(res.status).toBe(403);
    expect(mockListDrills).not.toHaveBeenCalled();
  });

  // CHANGED by the same decision. This route used to refuse the platform owner
  // on the reasoning that "a gym's drills are the gym's". The read is reached
  // only through the principal's own organization, so that reasoning is
  // satisfied rather than overridden -- an Omega read IS one gym's, and the
  // assertion below is what says so.
  test('admits the platform owner, and only to its own organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'platform_owner' }));

    const res = await GET(getRequest());

    expect(res.status).toBe(200);
    expect(mockListDrills).toHaveBeenCalledWith('org-1', { includeRetired: false });
  });

  test('the platform owner does not thereby see retired drills', async () => {
    // include_retired is gated on the AUTHOR list, which the decision left
    // alone. Reading the library and reading what the gym has taken out of it
    // are different questions, and only the first one was answered.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'platform_owner' }));

    const res = await GET(getRequest('?include_retired=true'));

    expect(res.status).toBe(200);
    expect(mockListDrills).toHaveBeenCalledWith('org-1', { includeRetired: false });
  });

  test('an athlete reads their own gym library', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));

    const res = await GET(getRequest());

    expect(res.status).toBe(200);
    expect(mockListDrills).toHaveBeenCalledWith('org-1', { includeRetired: false });
  });

  // The organization comes from the session, never from the request, so no
  // caller can read another gym's drills.
  test('ignores an organization_id supplied by the caller', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const res = await GET(getRequest('?organization_id=org-2'));

    expect(res.status).toBe(200);
    expect(mockListDrills).toHaveBeenCalledWith('org-1', { includeRetired: false });
  });

  test('a coach may see retired drills; an athlete may not', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    await GET(getRequest('?include_retired=true'));
    expect(mockListDrills).toHaveBeenLastCalledWith('org-1', { includeRetired: true });

    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
    await GET(getRequest('?include_retired=true'));
    expect(mockListDrills).toHaveBeenLastCalledWith('org-1', { includeRetired: false });
  });

  // Every test above asserts how listDrills was CALLED. None asserted what the
  // caller receives, and that gap is the whole reason the library shipped
  // broken: the route sent `items`, both clients read `drills`, each side's
  // tests passed, and the drill library rendered empty for every coach and
  // every athlete from the day it shipped.
  //
  // This asserts the body itself. The rows must arrive under the key the
  // clients actually read.
  test('answers with the drill rows under `items`, the key both clients read', async () => {
    const row = {
      organization_id: 'org-1',
      drill_id: 'drill-1',
      name: 'Pivot off the jab',
      category: 'footwork',
      focus: 'angle',
      cues: ['step first', 'hands home'],
      difficulty: 'beginner',
      active: true,
      created_at: '2026-08-01T00:00:00.000Z',
      updated_at: '2026-08-01T00:00:00.000Z',
    };
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockListDrills.mockResolvedValueOnce([row]);

    const res = await GET(getRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items).toEqual([row]);
    expect(body.organization_id).toBe('org-1');

    // The rows must not ALSO appear under the key the clients used to read, or
    // a client could be fixed back to the broken key and still pass.
    expect(body.drills).toBeUndefined();
  });

  /**
   * W-D2, owner rule of 2026-09-17: the promotion pointer is internal
   * provenance and does not go to an athlete.
   *
   * This is a redaction at the response, not a change to the read: listDrills
   * still returns the column, the coach library still depends on it, and the
   * athlete simply never receives it.
   */
  describe('the promotion pointer on an athlete response', () => {
    const promoted = () => drill({ drill_id: 'drill-promoted', reference_drill_id: 'drl_3c2aad1eb8baa9' });

    test('an athlete response omits reference_drill_id entirely', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
      mockListDrills.mockResolvedValueOnce([promoted()]);

      const body = await (await GET(getRequest())).json();

      expect(body.items).toHaveLength(1);
      // OMITTED, not nulled. `null` is a real value on this column meaning "a
      // coach typed this drill from scratch"; writing it here would tell the
      // athlete client something false rather than telling it nothing.
      expect(body.items[0]).not.toHaveProperty('reference_drill_id');
      expect(Object.keys(body.items[0]).sort()).toEqual([
        'active',
        'category',
        'created_at',
        'cues',
        'difficulty',
        'drill_id',
        'focus',
        'name',
        'organization_id',
        'updated_at',
      ]);
    });

    test('the rest of the athlete row is untouched', async () => {
      // Redaction must remove one field and change nothing else -- an athlete
      // still reads the gym's current operational library exactly as before.
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));
      mockListDrills.mockResolvedValueOnce([promoted()]);

      const body = await (await GET(getRequest())).json();
      const expected: Record<string, unknown> = { ...promoted() };
      delete expected.reference_drill_id;

      expect(body.items[0]).toEqual(expected);
      expect(body.ok).toBe(true);
      expect(body.organization_id).toBe('org-1');
    });

    test.each(['coach', 'organization_admin', 'admin', 'platform_owner', 'parent', 'volunteer', 'staff'] as const)(
      '%s keeps reference_drill_id',
      async (role) => {
        // The coach library marks promoted drills and opens their instructions
        // through exactly this pointer, so redacting it for everyone would
        // break that surface. Every non-athlete reader role is asserted, not
        // just coach, because the redaction is keyed on athlete alone.
        mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));
        mockListDrills.mockResolvedValueOnce([promoted()]);

        const body = await (await GET(getRequest())).json();

        expect(body.items[0].reference_drill_id).toBe('drl_3c2aad1eb8baa9');
      },
    );
  });
});

describe('POST /api/pilot/drills', () => {
  test('an athlete cannot write the gym library', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete', athleteId: 'ath-1' }));

    const res = await POST(bodyRequest('POST', { name: 'X', category: 'Y', focus: 'Z' }));

    expect(res.status).toBe(403);
    expect(mockCreateDrill).not.toHaveBeenCalled();
  });

  test('a coach creates a drill in their own organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(bodyRequest('POST', {
      organization_id: 'org-2',
      name: '  Straight Jab Retraction Snap  ',
      category: 'Striking',
      focus: 'Quick fist return to protect the chin.',
      cues: ['Elbow tucked', '  ', 'Snap on contact'],
      difficulty: 'advanced',
    }));

    expect(res.status).toBe(201);
    expect(mockCreateDrill).toHaveBeenCalledWith({
      organizationId: 'org-1',
      name: 'Straight Jab Retraction Snap',
      category: 'Striking',
      focus: 'Quick fist return to protect the chin.',
      cues: ['Elbow tucked', 'Snap on contact'],
      difficulty: 'advanced',
    });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'create',
      entity_type: 'drill',
      organization_id: 'org-1',
    }));
  });

  test('refuses a drill with no name', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(bodyRequest('POST', { name: '   ', category: 'Striking', focus: 'x' }));

    expect(res.status).toBe(400);
    expect(mockCreateDrill).not.toHaveBeenCalled();
  });

  test('refuses a difficulty outside the assignment vocabulary', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(bodyRequest('POST', {
      name: 'X', category: 'Y', focus: 'Z', difficulty: 'expert',
    }));

    expect(res.status).toBe(400);
    expect(mockCreateDrill).not.toHaveBeenCalled();
  });

  // A coach who is told "server error" has no way to find the drill that
  // already carries the name.
  test('a name the gym already uses reports the conflict', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockCreateDrill.mockRejectedValueOnce(new DrillNameTakenError('Straight Jab Retraction Snap'));

    const res = await POST(bodyRequest('POST', {
      name: 'Straight Jab Retraction Snap', category: 'Striking', focus: 'x', cues: ['Elbow tucked'],
    }));

    expect(res.status).toBe(409);
    expect(mockCreateDrill).toHaveBeenCalled();
    expect((await res.json()).error).toContain('Straight Jab Retraction Snap');
  });
});

// OD-2026-10-06-026 ruling 2: a technique drill needs at least one coaching
// cue before it can be used; a conditioning drill does not.
describe('the cue rule on a new drill', () => {
  test('refuses a technique drill with no cues, naming the missing cue, and writes nothing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(bodyRequest('POST', {
      name: 'Double Jab Entry',
      category: 'technical',
      focus: 'Close distance behind the jab.',
      cues: ['   '],
    }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: '"Double Jab Entry" has no coaching cue. A technique drill needs at least one coaching cue before it can be used; only a conditioning drill may go without. Add a cue first.',
      code: 'DRILL_CUE_REQUIRED',
    });
    expect(mockCreateDrill).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a conditioning drill with no cues is created (the exemption)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(bodyRequest('POST', {
      name: 'Rope 3 x 3',
      category: 'Conditioning',
      focus: 'Three rounds on the rope.',
    }));

    expect(res.status).toBe(201);
    expect(mockCreateDrill).toHaveBeenCalledWith(expect.objectContaining({ category: 'Conditioning', cues: undefined }));
  });

  test('a technique drill with one cue is created', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const res = await POST(bodyRequest('POST', {
      name: 'Double Jab Entry',
      category: 'technical',
      focus: 'Close distance behind the jab.',
      cues: ['Second jab lands as the foot does'],
    }));

    expect(res.status).toBe(201);
  });
});

describe('the cue rule on an edit', () => {
  test('refuses blanking the cues of a technique drill in use, and writes nothing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockGetDrill.mockResolvedValueOnce(drill({ active: true }));

    const res = await PATCH(bodyRequest('PATCH', { drill_id: 'drill-1', cues: [] }));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DRILL_CUE_REQUIRED');
    expect(mockUpdateDrill).not.toHaveBeenCalled();
  });

  test('refuses restoring a retired technique drill that has no cue', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockGetDrill.mockResolvedValueOnce(drill({ active: false, cues: [] }));

    const res = await PATCH(bodyRequest('PATCH', { drill_id: 'drill-1', active: true }));

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('DRILL_CUE_REQUIRED');
    expect(mockUpdateDrill).not.toHaveBeenCalled();
  });

  test('restoring a retired conditioning drill with no cue is allowed (the exemption)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockGetDrill.mockResolvedValueOnce(drill({ active: false, cues: [], category: 'conditioning' }));
    mockUpdateDrill.mockResolvedValueOnce(drill({ active: true, cues: [], category: 'conditioning' }));

    const res = await PATCH(bodyRequest('PATCH', { drill_id: 'drill-1', active: true }));

    expect(res.status).toBe(200);
  });

  test('retiring a cue-less technique drill is allowed: the rule governs use, not history', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockUpdateDrill.mockResolvedValueOnce(drill({ active: false, cues: [] }));

    const res = await PATCH(bodyRequest('PATCH', { drill_id: 'drill-1', active: false }));

    expect(res.status).toBe(200);
    expect(mockGetDrill).not.toHaveBeenCalled();
    expect(mockCueRule).not.toHaveBeenCalled();
  });

  test('an edit that touches neither cues nor category leaves an existing cue-less drill alone', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockUpdateDrill.mockResolvedValueOnce(drill({ cues: [], focus: 'Reworded.' }));

    const res = await PATCH(bodyRequest('PATCH', { drill_id: 'drill-1', focus: 'Reworded.' }));

    expect(res.status).toBe(200);
    expect(mockGetDrill).not.toHaveBeenCalled();
    expect(mockCueRule).not.toHaveBeenCalled();
  });

  test('a drill adopted from a conditioning reference drill is exempt by that discipline', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockGetDrill.mockResolvedValueOnce(drill({ active: true, cues: [], category: 'strength', reference_drill_id: 'drl_ref' }));
    (queryOne as jest.Mock).mockResolvedValueOnce({ discipline: 'conditioning' });
    mockUpdateDrill.mockResolvedValueOnce(drill({ active: true, cues: [], category: 'strength', reference_drill_id: 'drl_ref' }));

    const res = await PATCH(bodyRequest('PATCH', { drill_id: 'drill-1', cues: [] }));

    expect(res.status).toBe(200);
    expect(queryOne).toHaveBeenCalledWith(expect.stringContaining('from pilot.drill_library'), ['org-1', 'drl_ref']);
  });
});

describe('PATCH /api/pilot/drills', () => {
  test('a parent cannot edit a drill', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));

    const res = await PATCH(bodyRequest('PATCH', { drill_id: 'drill-1', active: false }));

    expect(res.status).toBe(403);
    expect(mockUpdateDrill).not.toHaveBeenCalled();
  });

  test('a coach retires a drill in their own organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const res = await PATCH(bodyRequest('PATCH', { drill_id: 'drill-1', active: false }));

    expect(res.status).toBe(200);
    expect(mockUpdateDrill).toHaveBeenCalledWith({
      organizationId: 'org-1',
      drillId: 'drill-1',
      name: undefined,
      category: undefined,
      focus: undefined,
      cues: undefined,
      difficulty: undefined,
      active: false,
    });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'update',
      entity_type: 'drill',
      details: expect.objectContaining({ active: false }),
    }));
  });

  // Another gym's drill_id matches no row in this organization.
  test('reports a miss instead of a silent success', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockUpdateDrill.mockResolvedValueOnce(null);

    const res = await PATCH(bodyRequest('PATCH', { drill_id: 'drill-from-org-2', active: false }));

    expect(res.status).toBe(404);
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('refuses an update with no drill_id', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());

    const res = await PATCH(bodyRequest('PATCH', { name: 'New name' }));

    expect(res.status).toBe(400);
    expect(mockUpdateDrill).not.toHaveBeenCalled();
  });

  test('a coach restores a retired drill, and the restore is audited', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockUpdateDrill.mockResolvedValueOnce(drill({ active: true }));

    const res = await PATCH(bodyRequest('PATCH', { drill_id: 'drill-1', active: true }));

    expect(res.status).toBe(200);
    expect(mockUpdateDrill).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      drillId: 'drill-1',
      active: true,
    }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'update',
      entity_type: 'drill',
      details: expect.objectContaining({ active: true }),
    }));
  });

  /**
   * W-D4C. A restore the lifecycle refuses is a conflict with the drill's
   * current state -- not a miss (404), not a bad request (400), and not a
   * server fault whose message is swallowed (500). The coach is told which
   * rule refused it, and `code` carries the reason so the page does not have to
   * match on wording.
   */
  describe('a restore the lifecycle refuses', () => {
    test.each([
      [
        'not_latest_version',
        'This is an earlier version of the drill. Restore its newest version instead.',
      ],
      [
        'another_version_active',
        'Another version of this drill is already in use in this gym.',
      ],
      [
        'reference_withdrawn',
        "This drill's reference has been withdrawn, so it cannot be restored.",
      ],
      // Round-1 repair R2: the guard refused but nothing refuses the drill on
      // a second look -- it changed in between. Still a 409 (the drill exists,
      // so not a 404), and the page is told to reload and retry rather than
      // which rule to satisfy.
      [
        'state_changed',
        'This drill changed while it was being restored. Reload the page and try again.',
      ],
    ] as const)('%s answers 409 with that reason as its code', async (reason, message) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal());
      mockUpdateDrill.mockRejectedValueOnce(new DrillRestoreRefusedError(reason));

      const res = await PATCH(bodyRequest('PATCH', { drill_id: 'drill-1', active: true }));

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: message, code: reason });
      expect(mockUpdateDrill).toHaveBeenCalledWith(expect.objectContaining({
        organizationId: 'org-1',
        drillId: 'drill-1',
        active: true,
      }));
      // Nothing changed, so nothing is recorded as having changed.
      expect(mockAudit).not.toHaveBeenCalled();
    });
  });

  // A restore sends no name; updateDrill reads the drill's own name so the
  // conflict still names the drill that could not come back.
  test('a restore whose name has since been taken reports the name, and is not audited', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal());
    mockUpdateDrill.mockRejectedValueOnce(new DrillNameTakenError('Slip and Lateral Pivot Step'));

    const res = await PATCH(bodyRequest('PATCH', { drill_id: 'drill-1', active: true }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: 'This gym already has a drill named "Slip and Lateral Pivot Step"',
    });
    expect(mockAudit).not.toHaveBeenCalled();
  });
});
