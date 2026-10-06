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
    // createComplianceViolation now inserts inside withTransaction (so the
    // insert and its escalation check commit together), so the insert
    // result comes back through the transaction client, not the bare query
    // mock. The rule-lookup that follows falls through to the mockTxQuery
    // default of { rows: [] }, which is fine -- this test doesn't assert on
    // escalation-filing, only on the violation itself landing.
    mockTxQuery.mockResolvedValueOnce({ rows: [{ violation_id: 'v1' }] });
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
    // Insert now runs through the transaction client -- see the equivalent
    // comment on the '201 when coach logs a violation' test above.
    mockTxQuery.mockResolvedValueOnce({ rows: [{ violation_id: 'v1' }] });
    const res = await POST(
      postRequest({ rule_id: 'r1', athlete_id: 'ath-1', video_session_id: 'vid-1' }),
    );
    expect(res.status).toBe(201);
  });

  // Filing a violation now has a screen behind it, so the create writes the
  // same audit row every lifecycle transition on this route already writes.
  test('a filed violation is audited with who filed it, against what, and at what severity', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
      .mockResolvedValueOnce({ rule_id: 'r1' }); // getComplianceRuleById
    mockTxQuery.mockResolvedValueOnce({ rows: [{ violation_id: 'v1', severity: 'high' }] });

    const res = await POST(postRequest({ rule_id: 'r1', athlete_id: 'ath-1', severity: 'high' }));

    expect(res.status).toBe(201);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'create',
      actor_account_id: 'acct-1',
      actor_role: 'coach',
      organization_id: 'org-1',
      entity_type: 'compliance_violation',
      entity_id: 'v1',
      details: expect.objectContaining({
        action: 'violation_filed',
        rule_id: 'r1',
        athlete_id: 'ath-1',
        severity: 'high',
        // A hand filing has no provenance for the audit row to name.
        source: null,
        proposal_id: null,
      }),
    }));
  });

  // details.source is provenance. A hand-filed violation must not be able to
  // call itself a machine detection, in the stored row or in the audit row.
  test.each(['automated_detection', 'Film_Study_Proposal', '', null])(
    'a claimed details.source of %p is refused as a 400, and nothing is filed or audited',
    async (source) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
      mockQueryOne
        .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
        .mockResolvedValueOnce({ rule_id: 'r1' }); // getComplianceRuleById

      const res = await POST(postRequest({ rule_id: 'r1', athlete_id: 'ath-1', details: { source } }));

      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/^Unsupported details\.source/);
      expect(mockWithTransaction).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    },
  );

  // A proposal cited with no source would be stored unchecked beside a
  // filing that never went through the proposal check.
  test('a details.proposal_id with no Film Study source is refused as a 400, and nothing is filed', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' })
      .mockResolvedValueOnce({ rule_id: 'r1' });

    const res = await POST(postRequest({
      rule_id: 'r1',
      athlete_id: 'ath-1',
      details: { proposal_id: '11111111-2222-4333-8444-555555555555' },
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Unsupported details\.proposal_id/);
    // Refused before any proposal lookup: only the access and rule reads ran.
    expect(mockQueryOne).toHaveBeenCalledTimes(2);
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a failed audit write does not report an already-committed filing as failed', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    mockQueryOne
      .mockResolvedValueOnce({ athlete_id: 'ath-1' })
      .mockResolvedValueOnce({ rule_id: 'r1' });
    mockTxQuery.mockResolvedValueOnce({ rows: [{ violation_id: 'v1', severity: 'medium' }] });
    mockAudit.mockRejectedValueOnce(Object.assign(new Error('audit down'), { code: '57P01' }));

    const res = await POST(postRequest({ rule_id: 'r1', athlete_id: 'ath-1' }));

    expect(res.status).toBe(201);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // Escalate to Compliance on the Film Study review queue files with
  // details { source: 'film_study_proposal', proposal_id }. That citation is
  // provenance an admin will follow, so the route holds it to the truth.
  describe('a violation escalated from a Film Study proposal', () => {
    const PROPOSAL_ID = '11111111-2222-4333-8444-555555555555';

    // clearAllMocks does not drop queued mockResolvedValueOnce values, so a
    // lookup one test staged and the route never made would otherwise answer
    // the next test's first query. Each case here starts and ends empty.
    beforeEach(() => { mockQueryOne.mockReset(); });
    afterEach(() => { mockQueryOne.mockReset(); mockTxQuery.mockReset(); });

    // The create transaction for a Film Study filing: lock the proposal row,
    // look for the same proposal already filed under the same rule, then (only
    // if there is none) insert. The rule lookup for auto-escalation after the
    // insert falls through to the { rows: [] } default.
    function stageFilingTransaction(existingViolationId?: string) {
      mockTxQuery
        .mockResolvedValueOnce({ rows: [{ proposal_id: PROPOSAL_ID }] }) // proposal row lock
        .mockResolvedValueOnce({ rows: existingViolationId ? [{ violation_id: existingViolationId }] : [] });
      if (!existingViolationId) {
        mockTxQuery.mockResolvedValueOnce({ rows: [{ violation_id: 'v1', severity: 'critical' }] }); // insert
      }
    }

    function violationInsert(): [string, unknown[]] | undefined {
      return mockTxQuery.mock.calls.find(([sql]) => String(sql).includes('insert into pilot.compliance_violations')) as
        | [string, unknown[]]
        | undefined;
    }

    function filmStudyPost(overrides: Record<string, unknown> = {}) {
      return postRequest({
        rule_id: 'r1',
        athlete_id: 'ath-1',
        video_session_id: 'vid-1',
        severity: 'critical',
        details: { source: 'film_study_proposal', proposal_id: PROPOSAL_ID },
        ...overrides,
      });
    }

    function stageUpToProposal() {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
      mockQueryOne
        .mockResolvedValueOnce({ athlete_id: 'ath-1' }) // assertCoachAssignedToAthlete
        .mockResolvedValueOnce({ rule_id: 'r1' }) // getComplianceRuleById
        .mockResolvedValueOnce({ video_session_id: 'vid-1', organization_id: 'org-1', athlete_id: 'ath-1' });
    }

    test('201 when the proposal is in this organization, about this athlete and this video', async () => {
      stageUpToProposal();
      mockQueryOne.mockResolvedValueOnce({
        proposal_id: PROPOSAL_ID,
        athlete_id: 'ath-1',
        video_session_id: 'vid-1',
      });
      stageFilingTransaction();

      const res = await POST(filmStudyPost());

      expect(res.status).toBe(201);
      // Looked up inside the caller's organization, never by id alone.
      const proposalLookup = mockQueryOne.mock.calls[3] as [string, unknown[]];
      expect(proposalLookup[0]).toContain('pilot.shadow_film_study_proposals');
      expect(proposalLookup[1]).toEqual(['org-1', PROPOSAL_ID]);
      // The duplicate check is org-scoped and keyed on this rule and proposal.
      const [lockSql, lockParams] = mockTxQuery.mock.calls[0] as [string, unknown[]];
      expect(lockSql).toContain('for update');
      expect(lockParams).toEqual(['org-1', PROPOSAL_ID]);
      const [dupSql, dupParams] = mockTxQuery.mock.calls[1] as [string, unknown[]];
      expect(dupSql).toContain("details->>'proposal_id'");
      expect(dupParams).toEqual(['org-1', 'r1', 'film_study_proposal', PROPOSAL_ID]);
      // The citation is stored on the violation.
      const insert = violationInsert();
      expect(insert).toBeDefined();
      expect(JSON.parse(String(insert?.[1][8]))).toEqual({ source: 'film_study_proposal', proposal_id: PROPOSAL_ID });
      expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
        details: expect.objectContaining({ source: 'film_study_proposal', proposal_id: PROPOSAL_ID }),
      }));
    });

    // Anything else the request put in details would sit beside a verified
    // citation and read as backed by the proposal. Only the pair is stored.
    test('only the verified citation is stored: other details keys sent with it are dropped', async () => {
      stageUpToProposal();
      mockQueryOne.mockResolvedValueOnce({ proposal_id: PROPOSAL_ID, athlete_id: 'ath-1', video_session_id: 'vid-1' });
      stageFilingTransaction();

      const res = await POST(filmStudyPost({
        details: {
          source: 'film_study_proposal',
          proposal_id: PROPOSAL_ID,
          observation_text: 'Made-up words the model never wrote.',
          confidence: 0.99,
        },
      }));

      expect(res.status).toBe(201);
      const stored = JSON.parse(String(violationInsert()?.[1][8])) as Record<string, unknown>;
      expect(stored).toEqual({ source: 'film_study_proposal', proposal_id: PROPOSAL_ID });
      const audited = (mockAudit.mock.calls[0][0] as { details: Record<string, unknown> }).details;
      expect(audited).not.toHaveProperty('observation_text');
      expect(audited).not.toHaveProperty('confidence');
    });

    // Reload the queue, pick the same rule on the same pending proposal, and
    // click Escalate again: that must not add a second register row, nor a
    // second escalation on the ladder (the insert is what files it).
    test('the same proposal filed again under the same rule is a 409 naming the existing violation, and nothing is inserted', async () => {
      stageUpToProposal();
      mockQueryOne.mockResolvedValueOnce({ proposal_id: PROPOSAL_ID, athlete_id: 'ath-1', video_session_id: 'vid-1' });
      stageFilingTransaction('violation-existing');

      const res = await POST(filmStudyPost());

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'This observation is already filed under this rule.',
        violation_id: 'violation-existing',
      });
      expect(violationInsert()).toBeUndefined();
      expect(mockTxQuery.mock.calls.some(([sql]) => String(sql).includes('pilot.safety_escalations'))).toBe(false);
      expect(mockAudit).not.toHaveBeenCalled();
    });

    test('a proposal gone between the check and the transaction is a hidden 404, and nothing is inserted', async () => {
      stageUpToProposal();
      mockQueryOne.mockResolvedValueOnce({ proposal_id: PROPOSAL_ID, athlete_id: 'ath-1', video_session_id: 'vid-1' });
      mockTxQuery.mockResolvedValueOnce({ rows: [] }); // proposal row lock finds nothing

      const res = await POST(filmStudyPost());

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect(violationInsert()).toBeUndefined();
      expect(mockAudit).not.toHaveBeenCalled();
    });

    test('a proposal from another organization (or none at all) is a hidden 404, and nothing is filed', async () => {
      stageUpToProposal();
      mockQueryOne.mockResolvedValueOnce(null);

      const res = await POST(filmStudyPost());

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'Not found' });
      expect(mockTxQuery).not.toHaveBeenCalled();
      expect(mockAudit).not.toHaveBeenCalled();
    });

    test('a proposal about a different athlete is a hidden 404, and nothing is filed', async () => {
      stageUpToProposal();
      mockQueryOne.mockResolvedValueOnce({ proposal_id: PROPOSAL_ID, athlete_id: 'ath-2', video_session_id: 'vid-1' });

      const res = await POST(filmStudyPost());

      expect(res.status).toBe(404);
      expect(mockTxQuery).not.toHaveBeenCalled();
    });

    test('a proposal about a different video is a hidden 404, and nothing is filed', async () => {
      stageUpToProposal();
      mockQueryOne.mockResolvedValueOnce({ proposal_id: PROPOSAL_ID, athlete_id: 'ath-1', video_session_id: 'vid-9' });

      const res = await POST(filmStudyPost());

      expect(res.status).toBe(404);
      expect(mockTxQuery).not.toHaveBeenCalled();
    });

    test('a Film Study source with no video cannot match its proposal', async () => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
      mockQueryOne
        .mockResolvedValueOnce({ athlete_id: 'ath-1' })
        .mockResolvedValueOnce({ rule_id: 'r1' })
        .mockResolvedValueOnce({ proposal_id: PROPOSAL_ID, athlete_id: 'ath-1', video_session_id: 'vid-1' });

      const res = await POST(filmStudyPost({ video_session_id: undefined }));

      expect(res.status).toBe(404);
      expect(mockTxQuery).not.toHaveBeenCalled();
    });

    test.each([undefined, '', 'not-a-uuid', 42])(
      'a Film Study source whose proposal_id is %p is a 400 before any proposal lookup',
      async (proposalId) => {
        stageUpToProposal();

        const res = await POST(filmStudyPost({ details: { source: 'film_study_proposal', proposal_id: proposalId } }));

        expect(res.status).toBe(400);
        expect(mockQueryOne).toHaveBeenCalledTimes(3);
        expect(mockTxQuery).not.toHaveBeenCalled();
      },
    );
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
      expect.objectContaining({ query: mockTxQuery }),
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

  // CX-3: the stated reason for closing a violation lives only in its audit
  // row. That row is written on the transition's own transaction client, so
  // a failed write rolls the closure back instead of leaving a closed
  // violation with no reason anywhere.
  test.each([
    ['resolve', 'resolved'],
    ['dismiss', 'dismissed'],
  ] as const)('%s writes its reason on the transition transaction', async (action, newStatus) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(violationRow({ status: 'acknowledged' }));
    mockTxQuery.mockResolvedValueOnce({ rows: [{ violation_id: 'v1', status: newStatus }] });

    const res = await PATCH(patchRequest({ violation_id: 'v1', action, note: 'Reviewed with the coach.' }));

    expect(res.status).toBe(200);
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const [event, client] = mockAudit.mock.calls[0];
    expect(event).toEqual(expect.objectContaining({
      entity_id: 'v1',
      details: expect.objectContaining({
        action: `violation_${action}`,
        prior_status: 'acknowledged',
        new_status: newStatus,
        note: 'Reviewed with the coach.',
      }),
    }));
    expect(client).toEqual(expect.objectContaining({ query: mockTxQuery }));
  });

  test.each(['resolve', 'dismiss'] as const)(
    'a %s whose reason cannot be recorded is not reported as done',
    async (action) => {
      mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
      mockQueryOne.mockResolvedValueOnce(violationRow({ status: 'acknowledged' }));
      mockTxQuery.mockResolvedValueOnce({ rows: [{ violation_id: 'v1', status: 'resolved' }] });
      mockAudit.mockRejectedValueOnce(new Error('audit table unavailable'));

      const res = await PATCH(patchRequest({ violation_id: 'v1', action, note: 'Reviewed with the coach.' }));

      expect(res.status).toBe(500);
    },
  );

  test('a failed audit write does not fail an acknowledgement that already committed', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'organization_admin' }));
    mockQueryOne.mockResolvedValueOnce(violationRow());
    mockTxQuery.mockResolvedValueOnce({ rows: [{ violation_id: 'v1', status: 'acknowledged' }] });
    mockAudit.mockRejectedValueOnce(new Error('audit table unavailable'));

    const res = await PATCH(patchRequest({ violation_id: 'v1', action: 'acknowledge' }));

    expect(res.status).toBe(200);
  });
});
