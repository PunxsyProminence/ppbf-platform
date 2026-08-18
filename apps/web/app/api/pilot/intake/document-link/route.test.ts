import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getPilotShadowSasUrl } from '@/src/server/pilot/blob';
import { getIntakeDocumentById } from '@/src/server/pilot/intake';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowReadiness', () => ({ assertShadowRuntimeReadiness: jest.fn() }));
jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));
jest.mock('@/src/server/pilot/blob', () => ({ getPilotShadowSasUrl: jest.fn() }));
jest.mock('@/src/server/pilot/intake', () => {
  const actual = jest.requireActual('@/src/server/pilot/intake');
  return { ...actual, getIntakeDocumentById: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockGetDocument = getIntakeDocumentById as jest.MockedFunction<typeof getIntakeDocumentById>;
const mockSas = getPilotShadowSasUrl as jest.MockedFunction<typeof getPilotShadowSasUrl>;
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
});

describe('POST /api/pilot/intake/document-link', () => {
  test('athletes cannot request document links', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('athlete'));
    const response = await POST(linkRequest({ intake_document_id: 'doc-1' }));
    expect(response.status).toBe(403);
    expect(mockSas).not.toHaveBeenCalled();
  });

  test('an unknown or cross-org document is a 404 and no link is minted', async () => {
    mockGetDocument.mockResolvedValue(null);
    const response = await POST(linkRequest({ intake_document_id: 'doc-x' }));
    expect(response.status).toBe(404);
    expect(mockSas).not.toHaveBeenCalled();
  });

  test('issues a short-lived read link for the document blob and audits the disclosure', async () => {
    mockGetDocument.mockResolvedValue({
      intake_document_id: 'doc-1',
      intake_case_id: 'case-1',
      file_name: 'waiver_consent.pdf',
      blob_path: 'quarantine/org-real/intake-1/waiver_consent.pdf',
    } as never);

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
    mockGetDocument.mockResolvedValue({
      intake_document_id: 'doc-1',
      intake_case_id: 'case-1',
      file_name: 'waiver_consent.pdf',
      blob_path: 'quarantine/org-real/intake-1/waiver_consent.pdf',
    } as never);

    const response = await POST(linkRequest({ intake_document_id: 'doc-1' }));

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  });
});
