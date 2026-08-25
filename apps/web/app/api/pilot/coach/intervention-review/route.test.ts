import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { accessibleAthleteIds, assertActorCanAccessAthlete } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  linkEvidence,
  listEvidence,
  removeEvidence,
  reviewOutcome,
} from '@/src/server/pilot/interventionEvidence';
import { getExecution, listExecutions } from '@/src/server/pilot/interventionExecutions';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/access', () => {
  const actual = jest.requireActual('@/src/server/pilot/access');
  return {
    ...actual,
    assertActorCanAccessAthlete: jest.fn(),
    accessibleAthleteIds: jest.fn().mockResolvedValue(new Set()),
  };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

jest.mock('@/src/server/pilot/interventionEvidence', () => {
  const actual = jest.requireActual('@/src/server/pilot/interventionEvidence');
  return {
    ...actual,
    linkEvidence: jest.fn(),
    removeEvidence: jest.fn(),
    reviewOutcome: jest.fn(),
    listEvidence: jest.fn().mockResolvedValue([]),
    getActiveReview: jest.fn().mockResolvedValue(null),
    getDecisionTexts: jest.fn().mockResolvedValue([]),
    getEvidenceLinkOwner: jest.fn(),
  };
});

jest.mock('@/src/server/pilot/interventionExecutions', () => {
  const actual = jest.requireActual('@/src/server/pilot/interventionExecutions');
  return { ...actual, getExecution: jest.fn(), listExecutions: jest.fn().mockResolvedValue([]) };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockAccess = assertActorCanAccessAthlete as jest.Mock;
const mockAccessible = accessibleAthleteIds as jest.Mock;
const mockLink = linkEvidence as jest.Mock;
const mockListEvidence = listEvidence as jest.Mock;
const mockListExecutions = listExecutions as jest.Mock;
const mockGetExecution = getExecution as jest.Mock;
const mockRemove = removeEvidence as jest.Mock;
const mockReview = reviewOutcome as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;
// Reached through the mocked module rather than a static import so this file
// still COMPILES against a tree where the removal path has no owner lookup at
// all -- which is what makes the refusal test below reproducible as a genuine
// behavioural failure on the unfixed code rather than a type error.
const mockLinkOwner = (jest.requireMock('@/src/server/pilot/interventionEvidence') as {
  getEvidenceLinkOwner: jest.Mock;
}).getEvidenceLinkOwner;

// The athlete gate is permissive by default so each test states its own
// access decision rather than inheriting the previous test's --
// clearAllMocks clears calls, not implementations.
beforeEach(() => {
  mockAccess.mockResolvedValue(undefined);
  mockAccessible.mockResolvedValue(new Set());
  // POST resolves the execution's athlete before acting; default to an
  // existing, accessible one so the action tests exercise the action, not
  // the gate. The gate has its own test.
  mockGetExecution.mockResolvedValue({ execution_id: 'ex-1', athlete_id: 'ath-1' });
  // PATCH now resolves the evidence link's own athlete the same way, for the
  // same reason. Fixture repair, not a relaxation: the pre-existing PATCH
  // test below asserts the shape of a LEGITIMATE removal, so its link has to
  // resolve to an athlete this coach may reach for that assertion to still be
  // testing what it was written to test.
  mockLinkOwner.mockResolvedValue({ link_id: 'l-1', execution_id: 'ex-1', athlete_id: 'ath-1' });
});

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: undefined,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const bodyRequest = (method: 'POST' | 'PATCH', body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/coach/intervention-review', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const REVIEW_BODY = {
  action: 'review_outcome',
  execution_id: 'ex-1',
  performance_result: 'declined',
  performance_notes: 'output fell further despite full delivery',
  hypothesis_result: 'contradicted',
  learning_signal: 'intervention_non_response',
};

test('athletes and parents cannot link evidence or record verdicts -- staff review only', async () => {
  for (const role of ['athlete', 'parent', 'platform_owner'] as const) {
    mockRequirePrincipal.mockResolvedValue(principal({ role }));
    expect((await GET(new NextRequest('http://localhost/api/pilot/coach/intervention-review'))).status).toBeGreaterThanOrEqual(400);
    expect((await POST(bodyRequest('POST', REVIEW_BODY))).status).toBeGreaterThanOrEqual(400);
  }
  expect(mockReview).not.toHaveBeenCalled();
});

test('linking evidence requires a real role and kind; an invented role or score-like kind is a 400', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await POST(bodyRequest('POST', {
    action: 'link_evidence', execution_id: 'ex-1', evidence_role: 'proof_it_worked',
    source_kind: 'training_attempt', source_id: 'att-1',
  }))).status).toBe(400);
  expect((await POST(bodyRequest('POST', {
    action: 'link_evidence', execution_id: 'ex-1', evidence_role: 'baseline',
    source_kind: 'vibes', source_id: 'v-1',
  }))).status).toBe(400);
  expect(mockLink).not.toHaveBeenCalled();

  mockLink.mockResolvedValue({ link_id: 'l-1', evidence_role: 'counterevidence', source_kind: 'training_attempt', source_id: 'att-1' });
  const response = await POST(bodyRequest('POST', {
    action: 'link_evidence', execution_id: 'ex-1', evidence_role: 'counterevidence',
    source_kind: 'training_attempt', source_id: 'att-1',
  }));
  expect(response.status).toBe(200);
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    entity_type: 'intervention_evidence_link',
    details: expect.objectContaining({ evidence_role: 'counterevidence' }),
  }));
});

test('a cross-scope source is a hidden not-found with no audit', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockLink.mockResolvedValue(null);

  expect((await POST(bodyRequest('POST', {
    action: 'link_evidence', execution_id: 'ex-1', evidence_role: 'baseline',
    source_kind: 'training_attempt', source_id: 'att-other-athlete',
  }))).status).toBe(404);
  expect(mockAudit).not.toHaveBeenCalled();
});

test('a review carries the three separate answers and audits them; invented vocab is a 400', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockReview.mockResolvedValue({
    review_id: 'r-1', performance_result: 'declined', hypothesis_result: 'contradicted',
    learning_signal: 'intervention_non_response', supersedes_review_id: null,
  });

  const response = await POST(bodyRequest('POST', REVIEW_BODY));
  expect(response.status).toBe(200);
  expect(mockReview).toHaveBeenCalledWith(expect.objectContaining({
    performanceResult: 'declined',
    hypothesisResult: 'contradicted',
    learningSignal: 'intervention_non_response',
    reviewedByAccountId: 'acct-1',
  }));
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    entity_type: 'intervention_outcome_review',
    details: expect.objectContaining({ hypothesis_result: 'contradicted' }),
  }));

  mockReview.mockClear();
  expect((await POST(bodyRequest('POST', { ...REVIEW_BODY, hypothesis_result: 'proven' }))).status).toBe(400);
  expect((await POST(bodyRequest('POST', { ...REVIEW_BODY, performance_notes: '  ' }))).status).toBe(400);
  expect(mockReview).not.toHaveBeenCalled();
});

test('a coach with no relationship to the execution\'s athlete cannot link evidence or file a review', async () => {
  // GET is per-athlete authorized; this POST was not, so a coach could attach
  // evidence or a recorded verdict to any execution in the org by naming its
  // id. The gate resolves the execution's athlete and refuses before either
  // action or its audit.
  mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-coach', role: 'coach' }));
  mockGetExecution.mockResolvedValue({ execution_id: 'ex-victim', athlete_id: 'ath-victim' });
  mockAccess.mockImplementation(async (_p: unknown, athleteId: string) => {
    if (athleteId === 'ath-victim') throw new Error('Forbidden: not your athlete');
  });

  const link = await POST(bodyRequest('POST', {
    action: 'link_evidence', execution_id: 'ex-victim', evidence_role: 'baseline',
    source_kind: 'training_attempt', source_id: 'att-1',
  }));
  const review = await POST(bodyRequest('POST', { ...REVIEW_BODY, execution_id: 'ex-victim' }));

  expect(link.status).toBeGreaterThanOrEqual(400);
  expect(review.status).toBeGreaterThanOrEqual(400);
  expect(mockAccess).toHaveBeenCalledWith(expect.anything(), 'ath-victim');
  expect(mockLink).not.toHaveBeenCalled();
  expect(mockReview).not.toHaveBeenCalled();
  expect(mockAudit).not.toHaveBeenCalled();
});

test('a POST naming an execution id absent from the org is a hidden 404 before any action', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockGetExecution.mockResolvedValue(null);
  const response = await POST(bodyRequest('POST', REVIEW_BODY));
  expect(response.status).toBe(404);
  expect(mockReview).not.toHaveBeenCalled();
});

test('removing evidence requires a stated reason; an unknown action is a 400', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));

  expect((await PATCH(bodyRequest('PATCH', { action: 'remove_evidence', link_id: 'l-1' }))).status).toBe(400);
  expect(mockRemove).not.toHaveBeenCalled();

  mockRemove.mockResolvedValue({ link_id: 'l-1', status: 'removed' });
  const response = await PATCH(bodyRequest('PATCH', {
    action: 'remove_evidence', link_id: 'l-1', removed_reason: 'linked the wrong attempt',
  }));
  expect(response.status).toBe(200);
  expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
    details: expect.objectContaining({ action: 'remove_evidence', removed_reason: 'linked the wrong attempt' }),
  }));

  expect((await PATCH(bodyRequest('PATCH', { action: 'delete_evidence', link_id: 'l-1' }))).status).toBe(400);
  expect((await POST(bodyRequest('POST', { action: 'auto_review', execution_id: 'ex-1' }))).status).toBe(400);
});

describe('removing evidence authorizes the athlete the link is STORED against', () => {
  // The bug: PATCH remove_evidence was gated on role alone. The GET on this
  // same route is per-athlete authorized, and the POST was given the same gate
  // for exactly this reason -- but removeEvidence keyed on (organization_id,
  // link_id) only, so ANY coach in the organization could strike a link off an
  // intervention belonging to a child they have no relationship to by naming
  // its link_id: no coach-of-record assignment, no coverage grant, nothing.
  //
  // The link_id needs no guessing. The GET hands out full evidence rows,
  // link_id included, for every athlete a coach may reach AT THE TIME. So a
  // substitute holding a 24-hour pilot.coach_coverage grant reads the board
  // legitimately, and once the grant lapses -- or an admin cuts it short with
  // revokeCoachCoverage, which exists precisely to end access early -- every
  // other surface refuses them while this one kept accepting the ids they
  // already had. The same holds for a coach reassigned off a roster.
  //
  // What that removes matters: 'counterevidence' and 'adverse_response' are
  // the roles recording that a child responded badly to an intervention, and a
  // stamped link no longer counts toward the outcome review.
  //
  // The removal must resolve the link's stored owner -- the athlete of its
  // stored execution, never a caller-supplied one -- authorize that athlete
  // through the same central gate the read uses, and compare-and-set on the
  // execution it just authorized.
  test('a coach with no standing on the link’s athlete is refused; nothing is stamped, nothing is audited', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-coach', role: 'coach' }));
    mockLinkOwner.mockResolvedValue({
      link_id: 'l-victim',
      execution_id: 'ex-victim',
      athlete_id: 'ath-victim',
    });
    mockAccess.mockImplementation(async (_p: unknown, athleteId: string) => {
      if (athleteId === 'ath-victim') throw new Error('Forbidden: coach not assigned to athlete');
    });

    const response = await PATCH(bodyRequest('PATCH', {
      action: 'remove_evidence',
      link_id: 'l-victim',
      removed_reason: 'does not belong here',
    }));

    expect(response.status).toBe(403);
    expect(mockAccess).toHaveBeenCalledWith(expect.anything(), 'ath-victim');
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a link_id outside the organization is a hidden 404 before any write', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({}));
    mockLinkOwner.mockResolvedValue(null);

    const response = await PATCH(bodyRequest('PATCH', {
      action: 'remove_evidence',
      link_id: 'l-other-org',
      removed_reason: 'linked the wrong attempt',
    }));

    expect(response.status).toBe(404);
    expect(mockAccess).not.toHaveBeenCalled();
    expect(mockRemove).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('a coach removing a link on their OWN athlete still works, as a compare-and-set on the stored execution', async () => {
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-coach', role: 'coach' }));
    mockLinkOwner.mockResolvedValue({ link_id: 'l-mine', execution_id: 'ex-mine', athlete_id: 'ath-mine' });
    mockRemove.mockResolvedValue({ link_id: 'l-mine', status: 'removed' });

    const response = await PATCH(bodyRequest('PATCH', {
      action: 'remove_evidence',
      link_id: 'l-mine',
      removed_reason: 'linked the wrong attempt',
    }));

    expect(response.status).toBe(200);
    expect(mockAccess).toHaveBeenCalledWith(expect.anything(), 'ath-mine');
    expect(mockRemove).toHaveBeenCalledWith({
      organizationId: 'org-1',
      linkId: 'l-mine',
      removedReason: 'linked the wrong attempt',
      expectedExecutionId: 'ex-mine',
    });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      entity_type: 'intervention_evidence_link',
      details: expect.objectContaining({ action: 'remove_evidence' }),
    }));
  });

  test('an organization admin may still remove a link for any athlete in their own organization', async () => {
    // The gate is assertActorCanAccessAthlete, which admits an organization
    // admin for any athlete in their org -- so widening nothing for a coach
    // must not narrow anything for an admin.
    mockRequirePrincipal.mockResolvedValue(principal({ accountId: 'acct-admin', role: 'organization_admin' }));
    mockLinkOwner.mockResolvedValue({ link_id: 'l-any', execution_id: 'ex-any', athlete_id: 'ath-any' });
    mockRemove.mockResolvedValue({ link_id: 'l-any', status: 'removed' });

    const response = await PATCH(bodyRequest('PATCH', {
      action: 'remove_evidence',
      link_id: 'l-any',
      removed_reason: 'superseded by a corrected attempt',
    }));

    expect(response.status).toBe(200);
    expect(mockRemove).toHaveBeenCalledWith(expect.objectContaining({ expectedExecutionId: 'ex-any' }));
  });
});

test('GET hands the evidence rows through with their read-time admissibility annotation intact', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockListExecutions.mockResolvedValueOnce([{ execution_id: 'ex-1', athlete_id: 'ath-1', status: 'completed' }]);
  // Unfiltered read: the row survives the scope filter only because this
  // coach may reach ath-1. What that filter does on its own is the next test.
  mockAccessible.mockResolvedValueOnce(new Set(['ath-1']));
  // listEvidence now returns source_admissible on every row (see
  // interventionEvidence.listEvidence): a pre-gate film-study link whose
  // proposal was rejected must reach the page saying so, not pass for
  // accepted -- and must still be present, never filtered.
  mockListEvidence.mockResolvedValueOnce([
    {
      link_id: 'l-film', evidence_role: 'immediate_post', source_kind: 'film_study',
      source_id: 'prop-1', note: '', status: 'active', removed_reason: '',
      source_admissible: false,
    },
    {
      link_id: 'l-att', evidence_role: 'baseline', source_kind: 'training_attempt',
      source_id: 'att-1', note: '', status: 'active', removed_reason: '',
      source_admissible: true,
    },
  ]);

  const response = await GET(new NextRequest('http://localhost/api/pilot/coach/intervention-review'));

  expect(response.status).toBe(200);
  const payload = (await response.json()) as { items: Array<{ evidence: Array<Record<string, unknown>> }> };
  expect(payload.items).toHaveLength(1);
  expect(payload.items[0].evidence.map((link) => [link.link_id, link.source_admissible])).toEqual([
    ['l-film', false],
    ['l-att', true],
  ]);
});

test('a coach with no relationship to the named athlete gets no review rows at all', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockAccess.mockRejectedValue(new Error('Forbidden: coach not assigned to athlete'));

  const response = await GET(
    new NextRequest('http://localhost/api/pilot/coach/intervention-review?athlete_id=ath-not-mine'),
  );

  expect(response.status).toBe(403);
  expect(mockListExecutions).not.toHaveBeenCalled();
  expect(mockListEvidence).not.toHaveBeenCalled();
});

test('an unfiltered review read is scoped to the athletes the caller may reach', async () => {
  mockRequirePrincipal.mockResolvedValue(principal({}));
  mockListExecutions.mockResolvedValueOnce([
    { execution_id: 'ex-mine', athlete_id: 'ath-mine', status: 'completed' },
    { execution_id: 'ex-theirs', athlete_id: 'ath-theirs', status: 'completed' },
  ]);
  mockAccessible.mockResolvedValueOnce(new Set(['ath-mine']));

  const response = await GET(new NextRequest('http://localhost/api/pilot/coach/intervention-review'));

  expect(response.status).toBe(200);
  const payload = (await response.json()) as { items: Array<{ execution: { execution_id: string } }> };
  expect(payload.items.map((item) => item.execution.execution_id)).toEqual(['ex-mine']);
  // The narrative and evidence of an unreachable athlete are never even read.
  expect(mockListEvidence).toHaveBeenCalledTimes(1);
  expect(mockListEvidence).toHaveBeenCalledWith('org-1', 'ex-mine');
});
