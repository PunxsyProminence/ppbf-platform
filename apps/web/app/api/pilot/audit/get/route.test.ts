import { NextRequest } from 'next/server';

import { POST } from './route';
import { query } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn().mockResolvedValue([]),
}));

jest.mock('@/src/server/pilot/http', () => ({
  ...jest.requireActual('@/src/server/pilot/http'),
  requirePrincipal: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;

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
