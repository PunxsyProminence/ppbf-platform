import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { query, queryOne, withTransaction } from '@/src/server/pilot/db';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/db', () => ({
  query: jest.fn(),
  queryOne: jest.fn(),
  // The lifecycle transition runs the REAL compliance module against this
  // mock: the transaction client's query maps onto mockTxQuery so tests can
  // stage CAS hits and misses.
  withTransaction: jest.fn(),
  sanitizedSqlState: jest.fn(() => undefined),
}));

jest.mock('@/src/server/pilot/audit', () => ({
  writePilotAuditEvent: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockQuery = query as jest.Mock;
const mockQueryOne = queryOne as jest.Mock;
const mockWithTransaction = withTransaction as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;
const mockTxQuery = jest.fn();

beforeEach(() => {
  mockWithTransaction.mockImplementation(
    (work: (client: { query: jest.Mock }) => Promise<unknown>) => work({ query: mockTxQuery }),
  );
  mockTxQuery.mockResolvedValue({ rows: [] });
});

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  };
}

function getRequest(query_?: string) {
  return new NextRequest(`http://localhost/api/pilot/compliance/violations${query_ ? `?${query_}` : ''}`);
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/compliance/violations', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/pilot/compliance/violations', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const res = await GET(getRequest());
    expect(res.status).toBe(401);
  });

  test('403 for a role that cannot view violations', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'volunteer' }));
    const res = await GET(getRequest());
    expect(res.status).toBe(403);
  });

  test('403 when coach filters by an unassigned athlete (cross-athlete)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await GET(getRequest('athlete_id=ath-other'));
    expect(res.status).toBe(403);
  });

  test('unfiltered coach request is scoped to assigned athletes only', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQuery.mockResolvedValueOnce([]);
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('coach_id ='),
      expect.arrayContaining(['acct-1']),
    );
  });

  test('unfiltered organization_admin request is org-wide, not coach-scoped', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQuery.mockResolvedValueOnce([]);
    const res = await GET(getRequest());
    expect(res.status).toBe(200);
    expect(mockQuery).toHaveBeenCalledWith(expect.not.stringContaining('coach_id ='), expect.anything());
  });

  describe('limit validation', () => {
    test.each(['0', '-1', 'NaN', '3.5', 'abc', '999999999999999999999'])(
      '400 for an invalid limit=%s',
      async (rawLimit) => {
        mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
        const res = await GET(getRequest(`limit=${rawLimit}`));
        expect(res.status).toBe(400);
      },
    );

    test('excessive limit is clamped to the safe maximum, not rejected', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
      mockQuery.mockResolvedValueOnce([]);
      const res = await GET(getRequest('limit=100000'));
      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([100]));
    });

    test('missing limit falls back to the default', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
      mockQuery.mockResolvedValueOnce([]);
      const res = await GET(getRequest());
      expect(res.status).toBe(200);
      expect(mockQuery).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([50]));
    });
  });
});

describe('POST /api/pilot/compliance/violations', () => {
  test('400 when required fields are missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    const res = await POST(postRequest({ rule_id: 'r1' }));
    expect(res.status).toBe(400);
  });

  // PATCH already guards the identical request.json() call with
  // .catch(() => null); POST did not, so malformed JSON threw a SyntaxError
  // that matched no branch in jsonError and fell through to a masked 500
  // instead of the clean 400 every other bad-input case on this route gets.
  test('malformed JSON returns 400, not a masked 500', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    const malformed = new NextRequest('http://localhost/api/pilot/compliance/violations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not valid json',
    });
    const res = await POST(malformed);
    expect(res.status).toBe(400);
  });

  test('403 when coach logs a violation against an unassigned athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(postRequest({ rule_id: 'r1', athlete_id: 'ath-other' }));
    expect(res.status).toBe(403);
  });

  test('201 when coach logs a violation against an assigned athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
      .mockResolvedValueOnce({ rule_id: 'r1' }); // getComplianceRuleById
    mockQuery.mockResolvedValueOnce([{ violation_id: 'v1' }]);
    const res = await POST(postRequest({ rule_id: 'r1', athlete_id: 'ath-1' }));
    expect(res.status).toBe(201);
  });

  test('403 when organization_admin logs a violation against an athlete from another organization (cross-organization write)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(null);
    const res = await POST(postRequest({ rule_id: 'r1', athlete_id: 'ath-other-org' }));
    expect(res.status).toBe(403);
  });

  test('cross-organization rule_id returns a hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete succeeds
      .mockResolvedValueOnce(null); // rule not found in this org
    const res = await POST(postRequest({ rule_id: 'r-other-org', athlete_id: 'ath-1' }));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('cross-organization video_session_id returns a hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
      .mockResolvedValueOnce({ rule_id: 'r1' }) // getComplianceRuleById
      .mockResolvedValueOnce(null); // video session not found in this org
    const res = await POST(
      postRequest({ rule_id: 'r1', athlete_id: 'ath-1', video_session_id: 'vid-other-org' }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
  });

  test('video_session_id attributed to a different athlete returns a hidden not-found response', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
      .mockResolvedValueOnce({ rule_id: 'r1' }) // getComplianceRuleById
      .mockResolvedValueOnce({ video_session_id: 'vid-1', organization_id: 'org-1', athlete_id: 'ath-2' });
    const res = await POST(
      postRequest({ rule_id: 'r1', athlete_id: 'ath-1', video_session_id: 'vid-1' }),
    );
    expect(res.status).toBe(404);
  });

  test('201 when video_session_id is attributed to the same athlete', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' })
      .mockResolvedValueOnce({ rule_id: 'r1' })
      .mockResolvedValueOnce({ video_session_id: 'vid-1', organization_id: 'org-1', athlete_id: 'ath-1' });
    mockQuery.mockResolvedValueOnce([{ violation_id: 'v1' }]);
    const res = await POST(
      postRequest({ rule_id: 'r1', athlete_id: 'ath-1', video_session_id: 'vid-1' }),
    );
    expect(res.status).toBe(201);
  });
});

function patchRequest(body: Record<string, unknown> | string) {
  return new NextRequest('http://localhost/api/pilot/compliance/violations', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function violationRow(overrides: Record<string, unknown> = {}) {
  return {
    violation_id: 'v1',
    rule_id: 'rule-1',
    video_session_id: null,
    athlete_id: 'ath-1',
    severity: 'high',
    status: 'new',
    escalation_status: 'pending',
    created_at: '2026-08-10T00:00:00.000Z',
    ...overrides,
  };
}

// The lifecycle levers, gated to the same role set as the escalate route --
// the only pre-existing violation lifecycle mutation. The CAS inside the
// real compliance module is the authority; these tests stage its hits and
// misses through the transaction client.
describe('PATCH /api/pilot/compliance/violations', () => {
  test.each(['coach', 'athlete', 'parent', 'board', 'staff', 'volunteer', 'platform_owner'] as const)(
    '%s cannot move a violation through its lifecycle',
    async (role) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role }));

      const res = await PATCH(patchRequest({ violation_id: 'v1', action: 'acknowledge' }));

      expect(res.status).toBe(403);
      expect(mockWithTransaction).not.toHaveBeenCalled();
    },
  );

  test('acknowledge succeeds from new and audits with prior and new state', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(violationRow());
    mockTxQuery.mockResolvedValueOnce({ rows: [{ violation_id: 'v1', status: 'acknowledged' }] });

    const res = await PATCH(patchRequest({ violation_id: 'v1', action: 'acknowledge' }));

    expect(res.status).toBe(200);
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'compliance_violation',
        entity_id: 'v1',
        actor_account_id: 'acct-1',
        details: expect.objectContaining({
          action: 'violation_acknowledge',
          prior_status: 'new',
          new_status: 'acknowledged',
        }),
      }),
    );
  });

  test('resolve and dismiss are refused without a stated reason, before any write', async () => {
    for (const action of ['resolve', 'dismiss'] as const) {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));

      const res = await PATCH(patchRequest({ violation_id: 'v1', action }));

      expect(res.status).toBe(400);
    }
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a cross-organization or missing violation is a hidden 404 before any mutation', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(null);

    const res = await PATCH(patchRequest({ violation_id: 'v-foreign', action: 'acknowledge' }));

    expect(res.status).toBe(404);
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a stale or concurrent transition gets a 409 naming the current state, and no audit event', async () => {
    // The row read as 'new', but another operator's transition committed
    // between the read and the CAS -- or the click was simply stale.
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(violationRow({ status: 'resolved' }));
    mockTxQuery.mockResolvedValueOnce({ rows: [] });

    const res = await PATCH(patchRequest({ violation_id: 'v1', action: 'acknowledge' }));

    expect(res.status).toBe(409);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe('resolved');
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('resolving an escalated violation stamps its escalation rows in the same transaction', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(violationRow({ status: 'escalated', escalation_status: 'in_progress' }));
    mockTxQuery
      .mockResolvedValueOnce({ rows: [{ violation_id: 'v1', status: 'resolved' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await PATCH(patchRequest({ violation_id: 'v1', action: 'resolve', note: 'Coach retrained; footage reviewed.' }));

    expect(res.status).toBe(200);
    const stamp = mockTxQuery.mock.calls[1];
    expect(stamp[0]).toContain('update pilot.violation_escalations');
    expect(stamp[0]).toContain('resolved_at is null');
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({
          action: 'violation_resolve',
          prior_status: 'escalated',
          new_status: 'resolved',
          note: 'Coach retrained; footage reviewed.',
        }),
      }),
    );
  });

  test('an unknown action and a malformed body are 400s, never 500s', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    const res1 = await PATCH(patchRequest({ violation_id: 'v1', action: 'delete' }));
    expect(res1.status).toBe(400);

    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    const res2 = await PATCH(patchRequest('not json {'));
    expect(res2.status).toBe(400);

    expect(mockWithTransaction).not.toHaveBeenCalled();
  });

  test('a failed audit write does not fail a transition that already committed', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(violationRow());
    mockTxQuery.mockResolvedValueOnce({ rows: [{ violation_id: 'v1', status: 'acknowledged' }] });
    mockAudit.mockRejectedValueOnce(new Error('audit table unavailable'));

    const res = await PATCH(patchRequest({ violation_id: 'v1', action: 'acknowledge' }));

    expect(res.status).toBe(200);
  });
});
