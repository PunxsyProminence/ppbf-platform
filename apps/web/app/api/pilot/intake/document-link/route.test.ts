import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotShadowSasUrl } from '@/src/server/pilot/blob';
import { getIntakeDocumentById } from '@/src/server/pilot/intake';
import { query, queryOne } from '@/src/server/pilot/db';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowReadiness', () => ({ assertShadowRuntimeReadiness: jest.fn() }));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/blob', () => ({ getPilotShadowSasUrl: jest.fn() }));
// db is mocked, NOT the access gate: assertActorCanAccessIntakeCase stays
// real so these tests exercise the decision instead of a stand-in for it.
jest.mock('@/src/server/pilot/db', () => ({ query: jest.fn(), queryOne: jest.fn() }));
jest.mock('@/src/server/pilot/intake', () => {
  const actual = jest.requireActual('@/src/server/pilot/intake');
  return { ...actual, getIntakeDocumentById: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockGetDocument = getIntakeDocumentById as jest.MockedFunction<typeof getIntakeDocumentById>;
const mockSas = getPilotShadowSasUrl as jest.MockedFunction<typeof getPilotShadowSasUrl>;
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
  file_name: 'waiver_consent.pdf',
  blob_path: 'quarantine/org-real/intake-1/waiver_consent.pdf',
} as never;

function linkRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/intake/document-link', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal());
  mockSas.mockReturnValue('https://storage.example/container/quarantine/org-real/doc.pdf?sig=abc');
  withDatabase(PENDING_CASE);
});

describe('POST /api/pilot/intake/document-link', () => {
  test('athletes cannot request document links', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('athlete'));
    const response = await POST(linkRequest({ intake_document_id: 'doc-1' }));
    expect(response.status).toBe(403);
    expect(mockSas).not.toHaveBeenCalled();
  });

  test('an unknown or cross-org document is a 404 and no link is minted', async () => {
    // Narrow on purpose: this proves the route's own null handling, because
    // the null comes from the mocked module return, not from an access
    // decision. The cross-org part of the name rests on
    // getIntakeDocumentById's own `organization_id = $1` predicate, which
    // this suite does not execute. The per-athlete refusals below are the
    // ones that exercise a real decision.
    mockGetDocument.mockResolvedValue(null);
    const response = await POST(linkRequest({ intake_document_id: 'doc-x' }));
    expect(response.status).toBe(404);
    expect(mockSas).not.toHaveBeenCalled();
  });

  test('issues a short-lived read link for the document blob and audits the disclosure', async () => {
    mockGetDocument.mockResolvedValue(DOCUMENT);

    const response = await POST(linkRequest({ intake_document_id: 'doc-1' }));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload).toMatchObject({
      ok: true,
      file_name: 'waiver_consent.pdf',
      expires_in_minutes: 15,
    });
    expect(payload.url).toContain('?');
    expect(mockSas).toHaveBeenCalledWith('quarantine/org-real/intake-1/waiver_consent.pdf', 15);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      entity_type: 'intake_document',
      entity_id: 'doc-1',
      details: expect.objectContaining({ action: 'document_link_issued' }),
    }));
  });

  test('the response carrying the SAS link is not storable by any cache', async () => {
    // The link is a bearer credential to a youth athlete's intake paperwork.
    // A cached copy is a second holder that no audit row names.
    mockGetDocument.mockResolvedValue(DOCUMENT);

    const response = await POST(linkRequest({ intake_document_id: 'doc-1' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });

  test('THE DEFECT: a coach with no relationship to the case gets no link', async () => {
    // Role alone used to be the whole gate here, which made this the last
    // step of a chain -- review-queue (admits coach, returns every case in
    // the organization) -> cases/get -> document id -> a 15-minute SAS URL to
    // any child's medical form or signed waiver.
    mockRequirePrincipal.mockResolvedValue(principal('coach', 'acct-other-coach'));
    mockGetDocument.mockResolvedValue(DOCUMENT);

    const response = await POST(linkRequest({ intake_document_id: 'doc-1' }));

    expect(response.status).toBe(403);
    expect(mockSas).not.toHaveBeenCalled();
    expect(mockAudit).not.toHaveBeenCalled();
  });

  test('the coach who filed the case still gets a link', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach', 'acct-uploader'));
    mockGetDocument.mockResolvedValue(DOCUMENT);

    const response = await POST(linkRequest({ intake_document_id: 'doc-1' }));

    expect(response.status).toBe(200);
    expect(mockSas).toHaveBeenCalledTimes(1);
  });

  test('on a promoted case the link follows the athlete the documents name', async () => {
    const promoted: Fixture = {
      intakeCase: { primary_athlete_id: null, submitted_by_account_id: 'acct-uploader' },
      documentOwners: ['ath-1'],
    };
    mockGetDocument.mockResolvedValue(DOCUMENT);

    mockRequirePrincipal.mockResolvedValue(principal('coach', 'acct-coach-of-record'));
    withDatabase({ ...promoted, coachAssigned: ['ath-1'] });
    expect((await POST(linkRequest({ intake_document_id: 'doc-1' }))).status).toBe(200);

    mockSas.mockClear();
    mockRequirePrincipal.mockResolvedValue(principal('coach', 'acct-other-coach'));
    withDatabase({ ...promoted, coachAssigned: ['ath-other'] });
    expect((await POST(linkRequest({ intake_document_id: 'doc-1' }))).status).toBe(403);
    expect(mockSas).not.toHaveBeenCalled();
  });

  test('a document whose case cannot be resolved is refused, not allowed through', async () => {
    mockGetDocument.mockResolvedValue(DOCUMENT);
    withDatabase({ intakeCase: null });

    const response = await POST(linkRequest({ intake_document_id: 'doc-1' }));

    expect(response.status).toBe(404);
    expect(mockSas).not.toHaveBeenCalled();
  });
});
