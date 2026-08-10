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
    // The coach-exclusion predicate is present in the SQL for every
    // caller, but $5 (isCoach) is false for an admin, so it is a no-op.
    expect(String(sql)).toContain('entity_type <> all($4::text[])');
    expect(params[4]).toBe(false);
  });

  // The training-holds route deliberately scopes a coach to their own
  // assigned athletes ("no org-wide hold roster") -- this general-purpose
  // reader must not become the back door around that decision.
  test('a coach explicitly requesting training_hold is refused outright', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(request({ entity_type: 'training_hold' }));

    expect(response.status).toBe(403);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  // A coach asking for "everything" (no entity_type filter) must not get
  // training_hold rows mixed into the results either -- the SQL predicate
  // strips them out rather than erroring the whole request.
  test('a coach reading with no entity_type filter has training_hold rows excluded at the SQL level', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    const response = await POST(request({}));

    expect(response.status).toBe(200);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('entity_type <> all($4::text[])');
    expect(params[1]).toBeNull(); // no entity_type filter requested
    expect(params[3]).toEqual(['training_hold']); // the excluded-types array
    expect(params[4]).toBe(true); // isCoach
  });

  test('a coach may still read an unrelated entity type', async () => {
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
