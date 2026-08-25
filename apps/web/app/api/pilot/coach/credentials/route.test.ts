import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { uploadPilotCredentialFile } from '@/src/server/pilot/blob';
import {
  getPersonClearanceForOrganization,
  listClearanceTypes,
  listPersonClearances,
  recordPersonClearance,
} from '@/src/server/pilot/clearanceRegister';
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
    // The read the upload now takes before it overwrites the row. Left as the
    // real implementation it would reach queryOne() and the database.
    // supersededClearanceState is deliberately NOT mocked: it is pure, and
    // these tests are about what it puts in the audit event.
    getPersonClearanceForOrganization: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockListClearanceTypes = listClearanceTypes as jest.Mock;
const mockListPersonClearances = listPersonClearances as jest.Mock;
const mockRecordPersonClearance = recordPersonClearance as jest.Mock;
const mockGetExisting = getPersonClearanceForOrganization as jest.Mock;
const mockAudit = writePilotAuditEvent as jest.Mock;
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

/**
 * This route's own header states the destruction as intended: "Uploading
 * always sets status='submitted' and clears any prior verification
 * (verified_by, verified_at, issued_on, expires_on) ... A new document
 * invalidates whatever an admin previously confirmed about the old one."
 *
 * What was never intended is that the invalidated answer went nowhere.
 * recordPersonClearance upserts on (organization, person, clearance type), so
 * there is exactly one row per person per clearance type and the previous one
 * is gone the instant this write lands -- while the audit event recorded only
 * the new document's sha256 and size.
 *
 * The scenario: a coach holds a PA Child Abuse History Certification recorded
 * `current`, issued 2026-01-10, valid to 2031-01-10, verified by an admin on
 * 2026-01-12. On 14 August they upload a fresh scan. A safeguarding review the
 * following week asks "was this coach cleared on the 14th, and until when" --
 * and before this guard, the register said 'submitted' with two null dates and
 * the trail said a document was submitted.
 */
describe('the audit event carries the clearance the upload destroys', () => {
  const CURRENT_CLEARANCE = {
    organization_id: 'org-1',
    clearance_id: 'clr-1',
    person_account_id: 'acct-1',
    clearance_type_id: 'ct-safesport',
    status: 'current',
    issued_on: '2026-01-10',
    expires_on: '2031-01-10',
    document_ref: 'org-1/acct-1/ct-safesport/old.pdf',
    verified_by_account_id: 'admin-7',
    verified_at: '2026-01-12T09:00:00Z',
    verification_note: 'card checked in person',
    created_at: '2026-01-10T00:00:00Z',
    updated_at: '2026-01-12T09:00:00Z',
  };

  function upload() {
    const file = new File([pdfBytes()], 'cert.pdf', { type: 'application/pdf' });
    return POST(uploadRequest({ clearance_type_id: 'ct-safesport', document: file }));
  }

  test('the superseded clearance is read BEFORE the overwrite, and recorded', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockListClearanceTypes.mockResolvedValueOnce([CLEARANCE_TYPE]);
    mockGetExisting.mockResolvedValueOnce(CURRENT_CLEARANCE);
    mockRecordPersonClearance.mockResolvedValueOnce({ clearance_id: 'clr-1' });

    expect((await upload()).status).toBe(202);

    // Read before written: if the order inverts, the read returns the row the
    // upload just overwrote and the audit records the new state twice.
    expect(mockGetExisting).toHaveBeenCalledWith('org-1', 'acct-1', 'ct-safesport');
    expect(mockGetExisting.mock.invocationCallOrder[0])
      .toBeLessThan(mockRecordPersonClearance.mock.invocationCallOrder[0]);

    expect(mockAudit).toHaveBeenCalledTimes(1);
    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      actor_account_id: 'acct-1',
      entity_type: 'person_clearance',
      details: {
        action: 'credential_submitted',
        superseded: {
          status: 'current',
          issued_on: '2026-01-10',
          expires_on: '2031-01-10',
          verified_by_account_id: 'admin-7',
          verified_at: '2026-01-12T09:00:00Z',
        },
      },
    });
  });

  // Null, not an object of nulls: a first-ever submission supersedes nothing,
  // and a block of nulls would read as "there was a record and it was blank".
  test('a first-ever submission records superseded: null, not a blank record', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockListClearanceTypes.mockResolvedValueOnce([CLEARANCE_TYPE]);
    mockGetExisting.mockResolvedValueOnce(null);
    mockRecordPersonClearance.mockResolvedValueOnce({ clearance_id: 'clr-new' });

    expect((await upload()).status).toBe(202);

    const details = mockAudit.mock.calls[0][0].details as { superseded?: unknown };
    expect(details.superseded).toBeNull();
  });

  // The document identity already recorded must survive alongside the new
  // field -- the superseded block is additive, not a replacement.
  test('the new document\'s own identity is still recorded', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockListClearanceTypes.mockResolvedValueOnce([CLEARANCE_TYPE]);
    mockGetExisting.mockResolvedValueOnce(CURRENT_CLEARANCE);
    mockRecordPersonClearance.mockResolvedValueOnce({ clearance_id: 'clr-1' });

    await upload();

    expect(mockAudit.mock.calls[0][0]).toMatchObject({
      details: {
        clearance_type_id: 'ct-safesport',
        content_type: 'application/pdf',
        content_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
  });
});
