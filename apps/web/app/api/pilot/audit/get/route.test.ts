import { NextRequest } from 'next/server';

import { POST } from './route';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import { accessibleAthleteIds } from '@/src/server/pilot/access';

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn().mockResolvedValue([]),
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
