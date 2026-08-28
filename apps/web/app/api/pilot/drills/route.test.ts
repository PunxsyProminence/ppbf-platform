import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { DrillNameTakenError, createDrill, listDrills, updateDrill } from '@/src/server/pilot/drills';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

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
    updateDrill: jest.fn(),
  };
});

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockListDrills = listDrills as jest.Mock;
const mockCreateDrill = createDrill as jest.Mock;
const mockUpdateDrill = updateDrill as jest.Mock;
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
      name: 'Straight Jab Retraction Snap', category: 'Striking', focus: 'x',
    }));

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('Straight Jab Retraction Snap');
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
});
