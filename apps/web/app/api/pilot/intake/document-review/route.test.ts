import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getIntakeDocumentById, reviewIntakeDocumentSecurity } from '@/src/server/pilot/intake';
import { query, queryOne } from '@/src/server/pilot/db';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowReadiness', () => ({ assertShadowRuntimeReadiness: jest.fn() }));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
// db is mocked, NOT the access gate: assertActorCanAccessIntakeCase stays
// real so these tests exercise the decision instead of a stand-in for it.
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
// isIntakeDocumentReadyForReview stays REAL: the route's ready_for_review
// answer must come from the same predicate approval uses, so these tests
// prove the states this route writes are the states approval accepts.
jest.mock('@/src/server/pilot/intake', () => {
  const actual = jest.requireActual('@/src/server/pilot/intake');
  return { ...actual, getIntakeDocumentById: jest.fn(), reviewIntakeDocumentSecurity: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockGetDocument = getIntakeDocumentById as jest.MockedFunction<typeof getIntakeDocumentById>;
const mockReview = reviewIntakeDocumentSecurity as jest.MockedFunction<typeof reviewIntakeDocumentSecurity>;
const mockAudit = writePilotAuditEvent as jest.MockedFunction<typeof writePilotAuditEvent>;
const mockQuery = jest.mocked(query);
const mockQueryOne = jest.mocked(queryOne);

function principal(
  role: PilotPrincipal['role'] = 'organization_admin',
  accountId = 'acct-admin',
): PilotPrincipal {
  return {
    accountId,
    role,
    organizationId: 'org-real',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

interface Fixture {
  intakeCase?: { primary_athlete_id: string | null; submitted_by_account_id: string } | null;
  documentOwners?: string[];
  coachAssigned?: string[];
  inOrganization?: string[];
}

function withDatabase(fixture: Fixture): void {
  mockQueryOne.mockImplementation(((sql: string, params: unknown[]) => {
    const text = String(sql);
    if (text.includes('from pilot.intake_cases')) {
      return Promise.resolve(fixture.intakeCase ?? null);
    }
    if (text.includes('from pilot.athletes') && text.includes('coach_id = $2')) {
      const [athleteId] = params as string[];
      return Promise.resolve(
        (fixture.coachAssigned ?? []).includes(athleteId) ? { athlete_id: athleteId } : null,
      );
    }
    if (text.includes('from pilot.athletes')) {
      const [athleteId] = params as string[];
      return Promise.resolve(
        (fixture.inOrganization ?? []).includes(athleteId) ? { athlete_id: athleteId } : null,
      );
    }
    if (text.includes('from pilot.coach_coverage')) {
      return Promise.resolve(null);
    }
    throw new Error(`unexpected queryOne in test: ${text}`);
  }) as never);

  mockQuery.mockImplementation(((sql: string) => {
    const text = String(sql);
    if (text.includes('from pilot.intake_documents')) {
      return Promise.resolve((fixture.documentOwners ?? []).map((id) => ({ owner_entity_id: id })));
    }
    throw new Error(`unexpected query in test: ${text}`);
  }) as never);
}

/** A pending case: the state every intake_cases row in this schema is in. */
const PENDING_CASE: Fixture = {
  intakeCase: { primary_athlete_id: null, submitted_by_account_id: 'acct-uploader' },
  documentOwners: [],
};

const DOCUMENT = {
  intake_document_id: 'doc-1',
  intake_case_id: 'case-1',
  file_name: 'medical_form.pdf',
  metadata: {},
} as never;

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
  mockGetDocument.mockResolvedValue(DOCUMENT);
  withDatabase(PENDING_CASE);
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

  test('an unknown or cross-org document is a 404, and nothing is written', async () => {
    // The null comes from the mocked lookup, not from an access decision, so
    // this proves the route's null handling only -- but it now also proves
    // ordering: the lookup happens BEFORE the update, so an unknown document
    // no longer reaches the write at all. It used to be discovered by the
    // update's own empty `returning`.
    mockGetDocument.mockResolvedValue(null);
    const response = await POST(reviewRequest({ intake_document_id: 'doc-x', decision: 'clean' }));
    expect(response.status).toBe(404);
    expect(mockReview).not.toHaveBeenCalled();
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

  test('THE DEFECT: an unrelated coach cannot attest on another case, and nothing is written', async () => {
    // 'clean' is not an opinion: it writes exactly the states
    // isIntakeDocumentReadyForReview demands, so an unauthorized attestation
    // here unblocks a promotion. The refusal must therefore land before the
    // update, not be discovered after it.
    mockRequirePrincipal.mockResolvedValue(principal('coach', 'acct-other-coach'));
    mockReview.mockResolvedValue(reviewedRow('clean'));

    const response = await POST(reviewRequest({ intake_document_id: 'doc-1', decision: 'clean' }));

    expect(response.status).toBe(403);
    expect(mockReview).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('the coach who filed the case can still review its documents', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach', 'acct-uploader'));
    mockReview.mockResolvedValue(reviewedRow('clean'));

    const response = await POST(reviewRequest({ intake_document_id: 'doc-1', decision: 'clean' }));

    expect(response.status).toBe(200);
    expect(mockReview).toHaveBeenCalledTimes(1);
  });

  test('on a promoted case review follows the athlete the documents name', async () => {
    const promoted: Fixture = {
      intakeCase: { primary_athlete_id: null, submitted_by_account_id: 'acct-uploader' },
      documentOwners: ['ath-1'],
    };
    mockReview.mockResolvedValue(reviewedRow('clean'));

    mockRequirePrincipal.mockResolvedValue(principal('coach', 'acct-coach-of-record'));
    withDatabase({ ...promoted, coachAssigned: ['ath-1'] });
    expect((await POST(reviewRequest({ intake_document_id: 'doc-1', decision: 'clean' }))).status).toBe(200);

    mockReview.mockClear();
    mockRequirePrincipal.mockResolvedValue(principal('coach', 'acct-other-coach'));
    withDatabase({ ...promoted, coachAssigned: ['ath-other'] });
    expect((await POST(reviewRequest({ intake_document_id: 'doc-1', decision: 'clean' }))).status).toBe(403);
    expect(mockReview).not.toHaveBeenCalled();
  });

  test('a document whose case cannot be resolved is refused, not written to', async () => {
    withDatabase({ intakeCase: null });

    const response = await POST(reviewRequest({ intake_document_id: 'doc-1', decision: 'clean' }));

    expect(response.status).toBe(404);
    expect(mockReview).not.toHaveBeenCalled();
  });
});
