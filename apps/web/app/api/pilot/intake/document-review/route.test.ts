import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { reviewIntakeDocumentSecurity } from '@/src/server/pilot/intake';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowReadiness', () => ({ assertShadowRuntimeReadiness: jest.fn() }));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
// isIntakeDocumentReadyForReview stays REAL: the route's ready_for_review
// answer must come from the same predicate approval uses, so these tests
// prove the states this route writes are the states approval accepts.
jest.mock('@/src/server/pilot/intake', () => {
  const actual = jest.requireActual('@/src/server/pilot/intake');
  return { ...actual, reviewIntakeDocumentSecurity: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockReview = reviewIntakeDocumentSecurity as jest.MockedFunction<typeof reviewIntakeDocumentSecurity>;
const mockAudit = writePilotAuditEvent as jest.MockedFunction<typeof writePilotAuditEvent>;

function principal(role: PilotPrincipal['role'] = 'organization_admin'): PilotPrincipal {
  return {
    accountId: 'acct-admin',
    role,
    organizationId: 'org-real',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function reviewRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/intake/document-review', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function reviewedRow(decision: 'clean' | 'quarantined') {
  const metadata = decision === 'clean'
    ? { security_state: 'clean', quarantine_status: 'clean', extraction_state: 'ready_for_review' }
    : { security_state: 'quarantined', quarantine_status: 'quarantined', extraction_state: 'blocked' };
  return {
    intake_document_id: 'doc-1',
    intake_case_id: 'case-1',
    file_name: 'medical_form.pdf',
    metadata,
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
});

describe('POST /api/pilot/intake/document-review', () => {
  test('athletes cannot review documents', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('athlete'));
    const response = await POST(reviewRequest({ intake_document_id: 'doc-1', decision: 'clean' }));
    expect(response.status).toBe(403);
    expect(mockReview).not.toHaveBeenCalled();
  });

  test('rejects a missing document id and an unknown decision', async () => {
    expect((await POST(reviewRequest({ decision: 'clean' }))).status).toBe(400);
    expect((await POST(reviewRequest({ intake_document_id: 'doc-1', decision: 'approve' }))).status).toBe(400);
    expect(mockReview).not.toHaveBeenCalled();
  });

  test('an unknown or cross-org document is a 404', async () => {
    mockReview.mockResolvedValue(null);
    const response = await POST(reviewRequest({ intake_document_id: 'doc-x', decision: 'clean' }));
    expect(response.status).toBe(404);
  });

  test('a clean decision reports the document ready for the approval predicate', async () => {
    mockReview.mockResolvedValue(reviewedRow('clean'));
    const response = await POST(reviewRequest({
      intake_document_id: 'doc-1',
      decision: 'clean',
      notes: 'Looked at the PDF; contents match the medical form.',
    }));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      intake_case_id: 'case-1',
      decision: 'clean',
      ready_for_review: true,
    });
    expect(mockReview).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-real',
      intakeDocumentId: 'doc-1',
      decision: 'clean',
      reviewedByAccountId: 'acct-admin',
    }));
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      entity_type: 'intake_document',
      entity_id: 'doc-1',
      details: expect.objectContaining({ action: 'document_security_review', decision: 'clean' }),
    }));
  });

  test('a quarantined decision leaves the document not ready, keeping approval blocked', async () => {
    mockReview.mockResolvedValue(reviewedRow('quarantined'));
    const response = await POST(reviewRequest({ intake_document_id: 'doc-1', decision: 'quarantined' }));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.ready_for_review).toBe(false);
  });
});
