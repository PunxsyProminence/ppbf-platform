import { NextRequest } from 'next/server';

import { GET, PATCH, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { requirePrincipal } from '@/src/server/pilot/http';
import {
  linkEvidence,
  removeEvidence,
  reviewOutcome,
} from '@/src/server/pilot/interventionEvidence';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
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
  };
});

jest.mock('@/src/server/pilot/interventionExecutions', () => {
  const actual = jest.requireActual('@/src/server/pilot/interventionExecutions');
  return { ...actual, listExecutions: jest.fn().mockResolvedValue([]) };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockLink = linkEvidence as jest.Mock;
const mockRemove = removeEvidence as jest.Mock;
const mockReview = reviewOutcome as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;

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
