import { NextRequest } from 'next/server';

import { POST } from './route';
import { getDrillWithDetail } from '@/src/server/pilot/drillLibraryV3';
import {
  DrillNameTakenError,
  ReferenceDrillAlreadyPromotedError,
  promoteReferenceDrill,
} from '@/src/server/pilot/drills';
import { requirePrincipal } from '@/src/server/pilot/http';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

// Promotion is the only bridge between the two drill models, so the cases that
// matter are the ones that decide WHICH model a row ends up in and WHOSE gym it
// belongs to. Everything is mocked except the route: this suite is about the
// route's contract, and the schema half is proven against real PostgreSQL in
// drillReferenceProvenance.pg.test.ts.

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/drillLibraryV3', () => ({
  getDrillWithDetail: jest.fn(),
}));

jest.mock('@/src/server/pilot/drills', () => {
  const actual = jest.requireActual('@/src/server/pilot/drills');
  return { ...actual, promoteReferenceDrill: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetReference = getDrillWithDetail as jest.Mock;
const mockPromote = promoteReferenceDrill as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

const REFERENCE_ID = 'drl_reference_1';

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

// Only the fields promotion reads. The reference row carries far more, and the
// point of naming just these is that the rest stays on pilot.drill_library.
function referenceDrill(overrides: Record<string, unknown> = {}) {
  return {
    organization_id: 'org-1',
    drill_id: REFERENCE_ID,
    name: 'Cross Return to Guard',
    discipline: 'boxing',
    category: 'technical',
    difficulty: 'intermediate',
    purpose: 'Return the rear hand to guard immediately after the cross.',
    target_behavior: 'Hand returns before the next punch starts.',
    standard_setup: 'Partners at technical distance.',
    requires_coach_authorization: false,
    active: true,
    cues: [
      { cue_id: 'cue-1', cue_text: 'Chin behind the shoulder' },
      { cue_id: 'cue-2', cue_text: 'Hand home first' },
    ],
    scale_levels: [{ scale_level: 'B', demand_description: 'Partner at pace' }],
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
