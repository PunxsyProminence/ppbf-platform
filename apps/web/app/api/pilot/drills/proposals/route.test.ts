import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query } from '@/src/server/pilot/db';
import { listDrillChangeProposals, proposeDrillChange } from '@/src/server/pilot/drillVersioning';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/drillVersioning', () => ({
  listDrillChangeProposals: jest.fn(),
  proposeDrillChange: jest.fn(),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn().mockResolvedValue(undefined),
}));

// The only query this route issues itself: which cited observation notes are
// in the caller's gym.
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn() }));

const mockQuery = query as jest.Mock;
const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listDrillChangeProposals as jest.Mock;
const mockPropose = proposeDrillChange as jest.Mock;
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

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    proposal_id: 'propchg_1',
    organization_id: 'org-1',
    lineage_id: 'lineage-1',
    based_on_drill_id: 'drill-1',
    proposed_by_account_id: 'coach-1',
    proposed_by_role: 'coach',
    rationale: 'The hand drops on the return.',
    proposed_change: { focus: 'Return the hand to the chin.' },
    observation_note_ids: [],
    review_state: 'proposed',
    reviewed_by_account_id: null,
    reviewed_at: null,
    review_note: null,
    resulting_drill_id: null,
    created_at: '2026-08-26T12:00:00.000Z',
    updated_at: '2026-08-26T12:00:00.000Z',
    ...overrides,
  };
}

function getRequest(search = '') {
  return new NextRequest(`http://localhost/api/pilot/drills/proposals${search}`);
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/drills/proposals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const validBody = {
  based_on_drill_id: 'drill-1',
  rationale: 'The hand drops on the return.',
  proposed_change: { focus: 'Return the hand to the chin.' },
};

beforeEach(() => {
  mockRequirePrincipal.mockResolvedValue(principal());
  mockList.mockResolvedValue([proposal()]);
  mockPropose.mockResolvedValue(proposal());
});

afterEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/pilot/drills/proposals', () => {
  test('rejects an unauthenticated caller', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    const res = await GET(getRequest());

    expect(res.status).toBe(401);
    expect(mockList).not.toHaveBeenCalled();
  });

  // A change proposal is internal coaching deliberation, not gym-wide reading.
  test.each(['athlete', 'parent', 'board', 'volunteer', 'staff'] as const)(
    'rejects %s',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));

      const res = await GET(getRequest());

      expect(res.status).toBe(403);
      expect(mockList).not.toHaveBeenCalled();
    },
  );

  test('scopes the read to the caller organization', async () => {
    await GET(getRequest());

    expect(mockList).toHaveBeenCalledWith('org-1', {
      reviewState: undefined,
      lineageId: undefined,
    });
  });

  test('passes the review_state and lineage_id filters through', async () => {
    await GET(getRequest('?review_state=proposed&lineage_id=lineage-1'));

    expect(mockList).toHaveBeenCalledWith('org-1', {
      reviewState: 'proposed',
      lineageId: 'lineage-1',
    });
  });

  // A typo matching nothing would render as an empty queue -- a load failure
  // presented as an absence.
  test('refuses an unrecognized review_state instead of returning nothing', async () => {
    const res = await GET(getRequest('?review_state=aproved'));

    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  // The mirror of the review_state check: a filter that silently does not
  // apply returns the whole queue while looking like a filtered view.
  test('refuses a present-but-blank lineage_id instead of dropping the filter', async () => {
    const res = await GET(getRequest('?lineage_id=%20'));

    expect(res.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('answers with the proposals', async () => {
    const res = await GET(getRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      organization_id: 'org-1',
      items: [proposal()],
    });
  });
});

describe('POST /api/pilot/drills/proposals', () => {
  test('rejects an unauthenticated caller', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(401);
    expect(mockPropose).not.toHaveBeenCalled();
  });

  test.each(['athlete', 'parent', 'board', 'volunteer', 'staff'] as const)(
    'rejects %s',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));

      const res = await POST(postRequest(validBody));

      expect(res.status).toBe(403);
      expect(mockPropose).not.toHaveBeenCalled();
    },
  );

  test('requires the drill the proposal is about', async () => {
    const res = await POST(postRequest({ ...validBody, based_on_drill_id: '   ' }));

    expect(res.status).toBe(400);
    expect(mockPropose).not.toHaveBeenCalled();
  });

  test('requires a rationale', async () => {
    const res = await POST(postRequest({ ...validBody, rationale: '  ' }));

    expect(res.status).toBe(400);
    expect(mockPropose).not.toHaveBeenCalled();
  });

  // Each of these would otherwise be accepted at propose time and die inside
  // adoptDrillChangeProposal's transaction on a check constraint, surfacing as
  // a 500 in front of the reviewer rather than a 400 in front of the author.
  test('refuses a difficulty outside the drill vocabulary', async () => {
    const res = await POST(
      postRequest({ ...validBody, proposed_change: { difficulty: 'banana' } }),
    );

    expect(res.status).toBe(400);
    expect(mockPropose).not.toHaveBeenCalled();
  });

  // The valid `focus` alongside the typo is load-bearing. With only the typo,
  // stripping the unknown-key guard leaves an EMPTY change set, so the
  // empty-change guard returns the same 400 and this test passes against the
  // broken code -- which is what it did until a mutation run caught it.
  test('refuses a field the adopter would silently ignore', async () => {
    const res = await POST(
      postRequest({
        ...validBody,
        proposed_change: { focus: 'Return the hand to the chin.', focuss: 'typo' },
      }),
    );

    expect(res.status).toBe(400);
    expect(mockPropose).not.toHaveBeenCalled();
  });

  test('refuses a proposed_change that changes nothing', async () => {
    const res = await POST(postRequest({ ...validBody, proposed_change: {} }));

    expect(res.status).toBe(400);
    expect(mockPropose).not.toHaveBeenCalled();
  });

  test('refuses non-string cues', async () => {
    const res = await POST(postRequest({ ...validBody, proposed_change: { cues: ['ok', 7] } }));

    expect(res.status).toBe(400);
    expect(mockPropose).not.toHaveBeenCalled();
  });

  // observation_note_ids is a uuid[] column: a non-UUID reaches Postgres as
  // 22P02 and surfaces as a 500.
  test('refuses observation note ids that are not UUIDs', async () => {
    const res = await POST(postRequest({ ...validBody, observation_note_ids: ['note-1'] }));

    expect(res.status).toBe(400);
    expect(mockPropose).not.toHaveBeenCalled();
  });

  // The column has no foreign key, so this route is the only place a cited
  // note is checked to be one of this gym's observations.
  describe('observation notes must be in the caller\'s gym', () => {
    const NOTE_A = '11111111-1111-4111-8111-111111111111';
    const NOTE_B = '22222222-2222-4222-8222-222222222222';

    test('asks about the cited ids in the caller\'s organization, and stores them when all are found', async () => {
      mockQuery.mockResolvedValueOnce([{ note_id: NOTE_A }, { note_id: NOTE_B }]);

      const res = await POST(postRequest({ ...validBody, observation_note_ids: [NOTE_A, NOTE_B] }));

      expect(res.status).toBe(201);
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/from pilot\.coach_observations\s+where organization_id = \$1\s+and note_id = any\(\$2::uuid\[\]\)/);
      expect(params).toEqual(['org-1', [NOTE_A, NOTE_B]]);
      expect(mockPropose).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: 'org-1', observationNoteIds: [NOTE_A, NOTE_B] }),
      );
    });

    test('refuses a proposal citing a note that is not in this gym, and stores nothing', async () => {
      // NOTE_B exists in another gym, or nowhere: the gym-scoped query does
      // not return it either way.
      mockQuery.mockResolvedValueOnce([{ note_id: NOTE_A }]);

      const res = await POST(postRequest({ ...validBody, observation_note_ids: [NOTE_A, NOTE_B] }));

      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({
        error: 'Unsupported observation_note_ids: each must be an observation note in this gym',
      });
      expect(mockPropose).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    });

    test('refuses when none of the cited notes is in this gym', async () => {
      mockQuery.mockResolvedValueOnce([]);

      const res = await POST(postRequest({ ...validBody, observation_note_ids: [NOTE_A] }));

      expect(res.status).toBe(400);
      expect(mockPropose).not.toHaveBeenCalled();
    });

    test('an id cited twice, or in another letter case, is one note', async () => {
      mockQuery.mockResolvedValueOnce([{ note_id: NOTE_A }]);
      const upper = NOTE_A.toUpperCase();

      const res = await POST(postRequest({ ...validBody, observation_note_ids: [NOTE_A, upper] }));

      expect(res.status).toBe(201);
      expect(mockQuery.mock.calls[0][1]).toEqual(['org-1', [NOTE_A]]);
    });

    test.each([
      ['no observation_note_ids key', {}],
      ['an empty list', { observation_note_ids: [] }],
      ['null', { observation_note_ids: null }],
    ])('a proposal with %s issues no query and is stored', async (_name, extra) => {
      const res = await POST(postRequest({ ...validBody, ...extra }));

      expect(res.status).toBe(201);
      expect(mockQuery).not.toHaveBeenCalled();
      expect(mockPropose).toHaveBeenCalledTimes(1);
    });

    test('a malformed body costs no query', async () => {
      const res = await POST(postRequest({ ...validBody, rationale: '', observation_note_ids: [NOTE_A] }));

      expect(res.status).toBe(400);
      expect(mockQuery).not.toHaveBeenCalled();
    });
  });

  // The route refuses proposed_change: {} because adopting it would mint a
  // byte-identical v2 and deactivate v1. Omitting the key entirely reached
  // the domain layer as `proposedChange ?? {}` -- the same stored value, by
  // a different spelling -- so the stated invariant has to hold both ways.
  test('refuses a proposal that omits proposed_change entirely', async () => {
    const res = await POST(
      postRequest({
        based_on_drill_id: validBody.based_on_drill_id,
        rationale: validBody.rationale,
      }),
    );

    expect(res.status).toBe(400);
    expect(mockPropose).not.toHaveBeenCalled();
  });

  test.each([['null', 'null'], ['an array', '[]'], ['a string', '"x"']])(
    'treats %s as a missing body rather than a server fault',
    async (_label, raw) => {
      const res = await POST(
        new NextRequest('http://localhost/api/pilot/drills/proposals', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: raw,
        }),
      );

      expect(res.status).toBe(400);
      expect(mockPropose).not.toHaveBeenCalled();
    },
  );

  // trim() does not strip U+0000. A NUL in a jsonb value reaches Postgres as
  // 22P05 (unsupported Unicode escape) and in a text column as 22021.
  test('refuses a NUL character rather than letting Postgres reject it', async () => {
    const res = await POST(
      postRequest({ ...validBody, proposed_change: { focus: 'a\u0000b' } }),
    );

    expect(res.status).toBe(400);
    expect(mockPropose).not.toHaveBeenCalled();
  });

  // An over-long name passes every check here and then fails the btree index
  // at ADOPT time (54000) -- in front of the reviewer, for the author's input.
  test('refuses an over-long field rather than failing at adopt time', async () => {
    const res = await POST(
      postRequest({ ...validBody, proposed_change: { name: 'x'.repeat(5000) } }),
    );

    expect(res.status).toBe(400);
    expect(mockPropose).not.toHaveBeenCalled();
  });

  test('refuses an over-long rationale', async () => {
    const res = await POST(postRequest({ ...validBody, rationale: 'x'.repeat(20000) }));

    expect(res.status).toBe(400);
    expect(mockPropose).not.toHaveBeenCalled();
  });

  test('reports an unknown drill as a miss, not a server fault', async () => {
    mockPropose.mockRejectedValueOnce(new Error('DRILL_NOT_FOUND'));

    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'DRILL_NOT_FOUND' });
  });

  test('records the proposal against the caller and their organization', async () => {
    const res = await POST(postRequest(validBody));

    expect(res.status).toBe(201);
    expect(mockPropose).toHaveBeenCalledWith({
      organizationId: 'org-1',
      basedOnDrillId: 'drill-1',
      proposedByAccountId: 'coach-1',
      proposedByRole: 'coach',
      rationale: 'The hand drops on the return.',
      proposedChange: { focus: 'Return the hand to the chin.' },
      observationNoteIds: undefined,
    });
  });

  // AUDIT_EVENT_TYPES is closed and mirrored by a check constraint, so a new
  // drill_change_* verb would fail the insert (23514) after the proposal row
  // had committed -- the exact failure the vocabulary migration was written
  // to fix.
  test('audits the proposal with a verb the constraint already admits', async () => {
    await POST(postRequest(validBody));

    expect(mockAudit).toHaveBeenCalledTimes(1);
    const event = mockAudit.mock.calls[0][0];
    expect(event.event_type).toBe('create');
    expect(event.entity_type).toBe('drill_change_proposal');
    expect(event.entity_id).toBe('propchg_1');
    expect(event.organization_id).toBe('org-1');
  });
});
