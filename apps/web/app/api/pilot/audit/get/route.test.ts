import { NextRequest } from 'next/server';

import { POST } from './route';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { accessibleAthleteIds } from '@/src/server/pilot/access';
import {
  AUDIT_ATHLETE_OWNED_ENTITY_TYPES,
  resolveAuditEntityOwners,
} from '@/src/server/pilot/auditEntityOwners';

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn().mockResolvedValue([]),
}));

// The resolver's table lookups are mocked; its type set and the ownersOf
// reader are the real ones, so the route is exercised against the real
// "which types are athlete-owned" answer.
jest.mock('@/src/server/pilot/auditEntityOwners', () => ({
  ...jest.requireActual('@/src/server/pilot/auditEntityOwners'),
  resolveAuditEntityOwners: jest.fn().mockResolvedValue(new Map()),
}));

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));

jest.mock('@/src/server/pilot/access', () => ({
  ...jest.requireActual('@/src/server/pilot/access'),
  accessibleAthleteIds: jest.fn().mockResolvedValue(new Set()),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockAccessible = accessibleAthleteIds as jest.Mock;
const mockResolveOwners = resolveAuditEntityOwners as jest.Mock;

/** Shape resolveAuditEntityOwners returns: type -> entity_id -> athlete ids. */
function owners(entries: Record<string, Record<string, string[]>>) {
  return new Map(
    Object.entries(entries).map(([type, byId]) => [type, new Map(Object.entries(byId))]),
  );
}

function principal(role: string) {
  return { accountId: 'acct-caller', role, organizationId: 'org-a', athleteId: null };
}

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest('https://ppbf.example/api/pilot/audit/get', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue([]);
  mockAccessible.mockResolvedValue(new Set());
  mockResolveOwners.mockResolvedValue(new Map());
});

describe('POST /api/pilot/audit/get — coach athlete scoping', () => {
  // The type allow-list is not enough: `goal` and `session` are allow-listed
  // but their audit rows carry details.athlete_id, so without this a coach
  // could enumerate which UNRELATED children had goal/session activity.
  const goalRows = [
    { entity_type: 'goal', entity_id: 'g-1', details: { athlete_id: 'ath-mine' } },
    { entity_type: 'goal', entity_id: 'g-2', details: { athlete_id: 'ath-victim' } },
    { entity_type: 'announcement', entity_id: 'a-1', details: {} },
  ];

  test('an allow-listed goal event for an unrelated athlete is not returned to a coach', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockQuery.mockResolvedValueOnce(goalRows);
    // The coach can reach ath-mine but not ath-victim.
    mockAccessible.mockResolvedValueOnce(new Set(['ath-mine']));

    const response = await POST(request({}));
    const payload = await response.json();

    expect(response.status).toBe(200);
    const ids = (payload.events as Array<{ entity_id: string }>).map((e) => e.entity_id);
    expect(ids).toContain('g-1'); // own athlete's goal — kept
    expect(ids).toContain('a-1'); // org-wide announcement (no athlete) — kept
    expect(ids).not.toContain('g-2'); // unrelated athlete's goal — scoped out
    // The relationship gate was consulted with the athletes the rows named.
    const askedFor = mockAccessible.mock.calls[0][1] as string[];
    expect(askedFor).toEqual(expect.arrayContaining(['ath-mine', 'ath-victim']));
  });

  test('the same goal event IS returned to a coach who can reach that athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockQuery.mockResolvedValueOnce(goalRows);
    mockAccessible.mockResolvedValueOnce(new Set(['ath-mine', 'ath-victim']));

    const response = await POST(request({}));
    const payload = await response.json();

    const ids = (payload.events as Array<{ entity_id: string }>).map((e) => e.entity_id);
    expect(ids).toEqual(expect.arrayContaining(['g-1', 'g-2', 'a-1']));
  });

  test('an org admin is not athlete-scoped and never consults the relationship gate', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockQuery.mockResolvedValueOnce(goalRows);

    const response = await POST(request({}));
    const payload = await response.json();

    expect((payload.events as unknown[]).length).toBe(3);
    expect(mockAccessible).not.toHaveBeenCalled();
  });

  test('a non-string entity_type is a 400, not a 500', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(request({ entity_type: { $ne: null } as unknown as string }));

    expect(response.status).toBe(400);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/audit/get', () => {
  test('org admin may read any entity type, including training_hold', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));

    const response = await POST(request({ entity_type: 'training_hold' }));

    expect(response.status).toBe(200);
    const [sql, params] = mockQuery.mock.calls[0];
    // The coach allow-list predicate is present in the SQL for every
    // caller, but $5 (isCoach) is false for an admin, so it is a no-op.
    expect(String(sql)).toContain('entity_type = any($4::text[])');
    expect(params[4]).toBe(false);
  });

  // The route used to carry a DENY-list with exactly one entry, and the
  // 2026-08-25 audit found the rot that shape guarantees: every sensitive
  // type added since (barrier reports, guardian consent, check-ins,
  // intake-medical) was coach-enumerable org-wide. The gate is an
  // allow-list now, and these pin the exact types that audit named --
  // each must be refused outright for a coach.
  test.each([
    'training_hold',
    'parent_barrier_report',
    'guardian_media_consent',
    'guardian_link',
    'athlete_check_in',
    'intake_case',
    'intake_document',
    'safety_flag',
    'person_clearance',
    'data_collection_request',
  ])('a coach explicitly requesting %s is refused outright', async (entityType) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(request({ entity_type: entityType }));

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // Fail closed on the FUTURE: a type nobody has adjudicated yet is
  // invisible to coaches until someone deliberately allow-lists it. This is
  // the assertion that makes the deny-list rot structurally impossible.
  test('a coach requesting an entity type that does not exist yet is refused, not served', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(request({ entity_type: 'entirely_new_sensitive_thing' }));

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // A coach asking for "everything" (no entity_type filter) gets only
  // allow-listed rows -- the SQL predicate keeps everything else out rather
  // than erroring the whole request.
  test('a coach reading with no entity_type filter is scoped to the allow-list at the SQL level', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(request({}));

    expect(response.status).toBe(200);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('entity_type = any($4::text[])');
    expect(params[1]).toBeNull(); // no entity_type filter requested
    expect(params[4]).toBe(true); // isCoach
    // The array bound is the allow-list itself: operational floor types
    // only, and none of the audit-named sensitive types.
    const allowed = params[3] as string[];
    expect(allowed).toContain('goal');
    expect(allowed).toContain('session');
    for (const banned of ['training_hold', 'parent_barrier_report', 'guardian_media_consent', 'athlete_check_in', 'intake_document', 'account', 'payment_account']) {
      expect(allowed).not.toContain(banned);
    }
  });

  test('a coach may still read an allow-listed operational type', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(request({ entity_type: 'goal' }));

    expect(response.status).toBe(200);
  });

  test('a role outside admin/coach is refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('athlete'));

    const response = await POST(request({}));

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/audit/get — every athlete a row names is gated (CL-A13)', () => {
  // A mentorship row names TWO athletes and neither under the key athlete_id.
  // The filter used to read details.athlete_id alone, so these rows counted as
  // "names no athlete" and reached every coach in the gym.
  const rows = [
    {
      entity_type: 'mentorship',
      entity_id: 'm-both-mine',
      details: { mentor_athlete_id: 'ath-mine', mentee_athlete_id: 'ath-mine-2' },
    },
    {
      entity_type: 'mentorship',
      entity_id: 'm-half-mine',
      details: { mentor_athlete_id: 'ath-mine', mentee_athlete_id: 'ath-victim' },
    },
    {
      entity_type: 'mentorship',
      entity_id: 'm-none-mine',
      details: { mentor_athlete_id: 'ath-victim', mentee_athlete_id: 'ath-victim-2' },
    },
    { entity_type: 'session', entity_id: 's-camel', details: { athleteId: 'ath-victim' } },
    { entity_type: 'session', entity_id: 's-list', details: { athlete_ids: ['ath-mine', 'ath-victim'] } },
    { entity_type: 'session', entity_id: 's-nested', details: { roster: [{ athlete_id: 'ath-victim' }] } },
    { entity_type: 'session', entity_id: 's-list-mine', details: { athlete_ids: ['ath-mine'] } },
    { entity_type: 'mentorship', entity_id: 'm-ended', details: { ended_on: '2026-10-01' } },
  ];

  test('a coach sees a row only when they can reach EVERY athlete it names', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockQuery.mockResolvedValueOnce(rows);
    mockAccessible.mockResolvedValueOnce(new Set(['ath-mine', 'ath-mine-2']));

    const response = await POST(request({}));
    const payload = await response.json();

    expect(response.status).toBe(200);
    const ids = (payload.events as Array<{ entity_id: string }>).map((e) => e.entity_id);
    // m-ended names no athlete but a mentorship is always about two
    // children, so it is hidden rather than treated as org-wide.
    expect(ids).toEqual(['m-both-mine', 's-list-mine']);
    const askedFor = mockAccessible.mock.calls[0][1] as string[];
    expect(askedFor).toEqual(
      expect.arrayContaining(['ath-mine', 'ath-mine-2', 'ath-victim', 'ath-victim-2']),
    );
  });

  test('an org admin still gets every row unfiltered', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockQuery.mockResolvedValueOnce(rows);

    const response = await POST(request({}));
    const payload = await response.json();

    expect(payload.events).toHaveLength(rows.length);
    expect(mockAccessible).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/audit/get \u2014 athlete-owned rows that name no athlete (CL-A13 review)', () => {
  // Many writers name the child only through entity_id: an intervention
  // execution's outcome update, a coach review's {session_id}. Those rows
  // used to count as org-wide and reach every coach. With the owner lookup
  // returning nothing for them (no such record), they stay hidden.
  const rows = [
    { entity_type: 'intervention_execution', entity_id: 'ex-1', details: { outcome: 'worse', correction_reason: 'free text' } },
    { entity_type: 'coach_review', entity_id: 'rev-1', details: { session_id: 'sess-1' } },
    { entity_type: 'announcement', entity_id: 'a-1', details: { placement: 'gym_notices' } },
    { entity_type: 'drill', entity_id: 'd-1', details: {} },
  ];

  test('a coach does not see them when their owner cannot be resolved; gym-wide types without an athlete are kept', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockQuery.mockResolvedValueOnce(rows);
    mockAccessible.mockResolvedValueOnce(new Set(['ath-mine']));

    const payload = await (await POST(request({}))).json();

    const ids = (payload.events as Array<{ entity_id: string }>).map((e) => e.entity_id);
    expect(ids).toEqual(['a-1', 'd-1']);
  });

  test('an org admin still sees them', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockQuery.mockResolvedValueOnce(rows);

    const payload = await (await POST(request({}))).json();

    expect(payload.events).toHaveLength(rows.length);
  });
});

describe('POST /api/pilot/audit/get — the owner of an athlete-owned row is resolved from entity_id', () => {
  // #1289 hid every athlete-owned row whose details named nobody, from the
  // assigned coach too. The owner is now read from the entity's own table.
  // For EVERY athlete-owned type: the assigned coach sees their athlete's
  // row, never another coach's athlete's row, and a row whose owner cannot
  // be resolved stays hidden.
  const OWNED_TYPES = [...AUDIT_ATHLETE_OWNED_ENTITY_TYPES].sort();

  test('the owned-type set is the seventeen types #1289 named', () => {
    expect(OWNED_TYPES).toEqual([
      'athlete_milestone',
      'athlete_program',
      'coach_coverage',
      'coach_note',
      'coach_review',
      'external_competition_entry',
      'goal',
      'intervention_evidence_link',
      'intervention_execution',
      'intervention_outcome_review',
      'mentorship',
      'one_percent_nomination',
      'recognition',
      'scheduler_coaching_request',
      'session',
      'video_session',
      'wrestling_league_roster_entry',
    ]);
  });

  test.each(OWNED_TYPES)(
    '%s: own athlete\'s row shown, another coach\'s athlete\'s row and an unresolved row hidden',
    async (entityType) => {
      const rows = [
        { entity_type: entityType, entity_id: 'e-mine', details: { action: 'update' } },
        { entity_type: entityType, entity_id: 'e-theirs', details: { action: 'update' } },
        { entity_type: entityType, entity_id: 'e-unresolved', details: { action: 'update' } },
      ];
      mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
      mockQuery.mockResolvedValueOnce(rows);
      mockResolveOwners.mockResolvedValueOnce(
        owners({ [entityType]: { 'e-mine': ['ath-mine'], 'e-theirs': ['ath-victim'] } }),
      );
      mockAccessible.mockResolvedValueOnce(new Set(['ath-mine']));

      const response = await POST(request({}));
      const payload = await response.json();

      expect(response.status).toBe(200);
      const ids = (payload.events as Array<{ entity_id: string }>).map((e) => e.entity_id);
      expect(ids).toEqual(['e-mine']);

      // The resolver was asked about exactly these rows, in the caller's gym.
      expect(mockResolveOwners).toHaveBeenCalledTimes(1);
      const [orgId, refs] = mockResolveOwners.mock.calls[0] as [string, Array<{ entity_type: string; entity_id: string }>];
      expect(orgId).toBe('org-a');
      expect(refs.map((r) => r.entity_id)).toEqual(['e-mine', 'e-theirs', 'e-unresolved']);
      // The relationship gate decided, on the resolved athletes.
      const askedFor = mockAccessible.mock.calls[0][1] as string[];
      expect(askedFor).toEqual(expect.arrayContaining(['ath-mine', 'ath-victim']));
    },
  );

  test('a mentorship is shown only when the coach reaches BOTH resolved athletes', async () => {
    const rows = [
      { entity_type: 'mentorship', entity_id: 'm-both', details: { ended_on: '2026-10-01' } },
      { entity_type: 'mentorship', entity_id: 'm-half', details: { ended_on: '2026-10-01' } },
    ];
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockQuery.mockResolvedValueOnce(rows);
    mockResolveOwners.mockResolvedValueOnce(
      owners({ mentorship: { 'm-both': ['ath-mine', 'ath-mine-2'], 'm-half': ['ath-mine', 'ath-victim'] } }),
    );
    mockAccessible.mockResolvedValueOnce(new Set(['ath-mine', 'ath-mine-2']));

    const payload = await (await POST(request({}))).json();

    const ids = (payload.events as Array<{ entity_id: string }>).map((e) => e.entity_id);
    expect(ids).toEqual(['m-both']);
  });

  test('details and the resolved owner are gated together: a resolved owner the coach cannot reach hides the row even when details name only their own athlete', async () => {
    const rows = [
      { entity_type: 'session', entity_id: 's-moved', details: { athlete_id: 'ath-mine' } },
    ];
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockQuery.mockResolvedValueOnce(rows);
    mockResolveOwners.mockResolvedValueOnce(owners({ session: { 's-moved': ['ath-victim'] } }));
    mockAccessible.mockResolvedValueOnce(new Set(['ath-mine']));

    const payload = await (await POST(request({}))).json();

    expect(payload.events).toEqual([]);
    const askedFor = mockAccessible.mock.calls[0][1] as string[];
    expect(askedFor).toEqual(expect.arrayContaining(['ath-mine', 'ath-victim']));
  });

  test('gym-wide rows are not sent to the resolver', async () => {
    const rows = [
      { entity_type: 'announcement', entity_id: 'a-1', details: {} },
      { entity_type: 'drill', entity_id: 'd-1', details: {} },
      { entity_type: 'goal', entity_id: 'g-1', details: {} },
    ];
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));
    mockQuery.mockResolvedValueOnce(rows);

    await POST(request({}));

    const [, refs] = mockResolveOwners.mock.calls[0] as [string, Array<{ entity_id: string }>];
    expect(refs.map((r) => r.entity_id)).toEqual(['g-1']);
  });

  test('an org admin never consults the resolver', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('organization_admin'));
    mockQuery.mockResolvedValueOnce([
      { entity_type: 'session', entity_id: 's-1', details: {} },
    ]);

    const payload = await (await POST(request({}))).json();

    expect(payload.events).toHaveLength(1);
    expect(mockResolveOwners).not.toHaveBeenCalled();
    expect(mockAccessible).not.toHaveBeenCalled();
  });
});
