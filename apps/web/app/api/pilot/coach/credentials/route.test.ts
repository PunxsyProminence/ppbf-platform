import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { uploadPilotCredentialFile } from '@/src/server/pilot/blob';
import { listClearanceTypes, listPersonClearances, recordPersonClearance } from '@/src/server/pilot/clearanceRegister';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

jest.mock('@/src/server/pilot/blob', () => ({
  uploadPilotCredentialFile: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/src/server/pilot/clearanceRegister', () => {
  const actual = jest.requireActual('@/src/server/pilot/clearanceRegister');
  return {
    ...actual,
    listClearanceTypes: jest.fn(),
    listPersonClearances: jest.fn(),
    recordPersonClearance: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockListClearanceTypes = listClearanceTypes as jest.Mock;
const mockListPersonClearances = listPersonClearances as jest.Mock;
const mockRecordPersonClearance = recordPersonClearance as jest.Mock;
const mockUpload = uploadPilotCredentialFile as jest.Mock;

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
  } as PilotPrincipal;
}

const CLEARANCE_TYPE = {
  organization_id: 'org-1',
  clearance_type_id: 'ct-safesport',
  name: 'SafeSport Training',
  issuing_authority: 'U.S. Center for SafeSport',
  authority_kind: 'governing_body',
  level_label: null,
  validity_months: 12,
  renewal_grace_days: 30,
  external_reference: null,
  active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function getRequest() {
  return new NextRequest('http://localhost/api/pilot/coach/credentials');
}

function pdfBytes(): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0x00, 0x00]);
}

function uploadRequest(fields: Record<string, string | Blob>, contentLength = 4096) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  return new NextRequest('http://localhost/api/pilot/coach/credentials', {
    method: 'POST',
    body: formData,
    headers: { 'content-length': String(contentLength) },
  });
}

describe('GET /api/pilot/coach/credentials', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    expect((await GET(getRequest())).status).toBe(401);
  });

  test('403 for a role that does not hold staff credentials', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'athlete' }));
    expect((await GET(getRequest())).status).toBe(403);
  });

  test('lists active clearance types with the caller\'s own status, never a document_ref', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockListClearanceTypes.mockResolvedValueOnce([CLEARANCE_TYPE]);
    mockListPersonClearances.mockResolvedValueOnce([{
      organization_id: 'org-1',
      clearance_id: 'clr-1',
      person_account_id: 'acct-1',
      clearance_type_id: 'ct-safesport',
      status: 'submitted',
      issued_on: null,
      expires_on: null,
      document_ref: 'org-1/acct-1/ct-safesport/credential.pdf',
      verified_by_account_id: null,
      verified_at: null,
      verification_note: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }]);

    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      clearance_type_id: 'ct-safesport',
      status: 'submitted',
      band: 'submitted',
      has_document: true,
    });
    expect(body.items[0]).not.toHaveProperty('document_ref');
    expect(mockListPersonClearances).toHaveBeenCalledWith('org-1', { personAccountId: 'acct-1' });
  });

  test('an unheld clearance type shows as missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockListClearanceTypes.mockResolvedValueOnce([CLEARANCE_TYPE]);
    mockListPersonClearances.mockResolvedValueOnce([]);

    const body = (await (await GET(getRequest())).json()) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({ status: 'not_started', band: 'missing', has_document: false });
  });
});

describe('POST /api/pilot/coach/credentials', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    const file = new File([pdfBytes()], 'cert.pdf', { type: 'application/pdf' });
    expect((await POST(uploadRequest({ clearance_type_id: 'ct-safesport', document: file }))).status).toBe(401);
  });

  test('403 for a role that cannot self-upload', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'parent' }));
    const file = new File([pdfBytes()], 'cert.pdf', { type: 'application/pdf' });
    expect((await POST(uploadRequest({ clearance_type_id: 'ct-safesport', document: file }))).status).toBe(403);
  });

  test('400 when clearance_type_id is missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    const file = new File([pdfBytes()], 'cert.pdf', { type: 'application/pdf' });
    expect((await POST(uploadRequest({ document: file }))).status).toBe(400);
    expect(mockListClearanceTypes).not.toHaveBeenCalled();
  });

  test('400 when clearance_type_id does not name an active clearance type in this organization', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockListClearanceTypes.mockResolvedValueOnce([CLEARANCE_TYPE]);
    const file = new File([pdfBytes()], 'cert.pdf', { type: 'application/pdf' });
    const res = await POST(uploadRequest({ clearance_type_id: 'ct-not-real', document: file }));
    expect(res.status).toBe(400);
    expect(mockRecordPersonClearance).not.toHaveBeenCalled();
  });

  test('400 when the document is missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockListClearanceTypes.mockResolvedValueOnce([CLEARANCE_TYPE]);
    const res = await POST(uploadRequest({ clearance_type_id: 'ct-safesport' }));
    expect(res.status).toBe(400);
  });

  test('415 for an unsupported file type', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockListClearanceTypes.mockResolvedValueOnce([CLEARANCE_TYPE]);
    const file = new File([new Uint8Array([1, 2, 3])], 'cert.docx', { type: 'application/msword' });
    const res = await POST(uploadRequest({ clearance_type_id: 'ct-safesport', document: file }));
    expect(res.status).toBe(415);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  test('415 when the bytes do not match the declared PDF type', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockListClearanceTypes.mockResolvedValueOnce([CLEARANCE_TYPE]);
    const spoofed = new File([new Uint8Array([0, 1, 2, 3])], 'cert.pdf', { type: 'application/pdf' });
    const res = await POST(uploadRequest({ clearance_type_id: 'ct-safesport', document: spoofed }));
    expect(res.status).toBe(415);
    expect(mockUpload).not.toHaveBeenCalled();
  });

  test('202 on a valid upload: stores under the org/account/type path, and never sets status to current', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockListClearanceTypes.mockResolvedValueOnce([CLEARANCE_TYPE]);
    mockRecordPersonClearance.mockResolvedValueOnce({ clearance_id: 'clr-new' });

    const file = new File([pdfBytes()], 'cert.pdf', { type: 'application/pdf' });
    const res = await POST(uploadRequest({ clearance_type_id: 'ct-safesport', document: file }));

    expect(res.status).toBe(202);
    expect(mockUpload).toHaveBeenCalledWith(
      'org-1/acct-1/ct-safesport/credential.pdf',
      expect.any(Uint8Array),
      'application/pdf',
    );
    expect(mockRecordPersonClearance).toHaveBeenCalledWith(expect.objectContaining({
      organizationId: 'org-1',
      personAccountId: 'acct-1',
      clearanceTypeId: 'ct-safesport',
      status: 'submitted',
      documentRef: 'org-1/acct-1/ct-safesport/credential.pdf',
      issuedOn: null,
      expiresOn: null,
      verifiedByAccountId: null,
    }));
  });
});
