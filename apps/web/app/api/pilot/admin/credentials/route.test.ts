import { NextRequest } from 'next/server';

import { GET, POST } from './route';
import {
  getPersonClearanceForOrganization,
  listClearanceTypes,
  listPersonClearancesForVerification,
  recordPersonClearance,
} from '@/src/server/pilot/clearanceRegister';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/audit', () => ({ writePilotAuditEvent: jest.fn() }));

jest.mock('@/src/server/pilot/clearanceRegister', () => {
  const actual = jest.requireActual('@/src/server/pilot/clearanceRegister');
  return {
    ...actual,
    listPersonClearancesForVerification: jest.fn(),
    getPersonClearanceForOrganization: jest.fn(),
    listClearanceTypes: jest.fn(),
    recordPersonClearance: jest.fn(),
  };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockList = listPersonClearancesForVerification as jest.Mock;
const mockGetExisting = getPersonClearanceForOrganization as jest.Mock;
const mockListClearanceTypes = listClearanceTypes as jest.Mock;
const mockRecord = recordPersonClearance as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'admin-1',
    role: 'admin',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
    ...overrides,
  } as PilotPrincipal;
}

const EXISTING_ROW = {
  organization_id: 'org-1',
  clearance_id: 'clr-1',
  person_account_id: 'acct-9',
  clearance_type_id: 'ct-safesport',
  status: 'submitted',
  issued_on: null,
  expires_on: null,
  document_ref: 'org-1/acct-9/ct-safesport/credential.pdf',
  verified_by_account_id: null,
  verified_at: null,
  verification_note: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

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

const getReq = () => new NextRequest('http://localhost/api/pilot/admin/credentials');
const post = (body: Record<string, unknown>) =>
  new NextRequest('http://localhost/api/pilot/admin/credentials', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('GET /api/pilot/admin/credentials', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    expect((await GET(getReq())).status).toBe(401);
  });

  test('403 for a coach -- verification is admin-only', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    expect((await GET(getReq())).status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  test('lists queue rows with a resolved display name, band, and has_document rather than document_ref', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockList.mockResolvedValueOnce([{
      organization_id: 'org-1',
      clearance_id: 'clr-1',
      person_account_id: 'acct-9',
      person_login_email: 'jane.okafor@example.com',
      person_role: 'coach',
      clearance_type_id: 'ct-safesport',
      clearance_name: 'SafeSport Training',
      issuing_authority: 'U.S. Center for SafeSport',
      validity_months: 12,
      status: 'submitted',
      issued_on: null,
      expires_on: null,
      document_ref: 'org-1/acct-9/ct-safesport/credential.pdf',
      verified_by_account_id: null,
      verified_at: null,
      verification_note: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }]);

    const response = await GET(getReq());
    expect(response.status).toBe(200);
    const body = (await response.json()) as { items: Array<Record<string, unknown>> };
    expect(body.items[0]).toMatchObject({
      person_display_name: 'Jane Okafor',
      band: 'submitted',
      has_document: true,
    });
    expect(body.items[0]).not.toHaveProperty('document_ref');
  });
});

describe('POST /api/pilot/admin/credentials', () => {
  test('403 for organization_admin\'s own downstream role is fine, but coach is refused', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ role: 'coach' }));
    expect((await POST(post({ action: 'verify' }))).status).toBe(403);
  });

  test('400 when person_account_id or clearance_type_id is missing', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    expect((await POST(post({ action: 'verify', clearance_type_id: 'ct-safesport' }))).status).toBe(400);
    expect(mockGetExisting).not.toHaveBeenCalled();
  });

  test('404-shaped refusal when no submission exists for this org/person/type', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetExisting.mockResolvedValueOnce(null);
    const res = await POST(post({ action: 'verify', person_account_id: 'acct-9', clearance_type_id: 'ct-safesport', issued_on: '2026-01-01' }));
    expect(res.status).toBe(404);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('verify requires issued_on', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetExisting.mockResolvedValueOnce(EXISTING_ROW);
    const res = await POST(post({ action: 'verify', person_account_id: 'acct-9', clearance_type_id: 'ct-safesport' }));
    expect(res.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();
  });

  test('verify with an explicit expires_on stores exactly what the admin sent', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetExisting.mockResolvedValueOnce(EXISTING_ROW);
    mockListClearanceTypes.mockResolvedValueOnce([CLEARANCE_TYPE]);
    mockRecord.mockResolvedValueOnce({ clearance_id: 'clr-1', status: 'current', expires_on: '2029-01-01' });

    const res = await POST(post({
      action: 'verify', person_account_id: 'acct-9', clearance_type_id: 'ct-safesport',
      issued_on: '2026-01-01', expires_on: '2029-01-01', note: 'checked the card in person',
    }));

    expect(res.status).toBe(200);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
      personAccountId: 'acct-9',
      clearanceTypeId: 'ct-safesport',
      status: 'current',
      issuedOn: '2026-01-01',
      expiresOn: '2029-01-01',
      documentRef: EXISTING_ROW.document_ref,
      verifiedByAccountId: 'admin-1',
      verificationNote: 'checked the card in person',
    }));
  });

  test('verify without an explicit expires_on computes one from the clearance type\'s validity_months', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetExisting.mockResolvedValueOnce(EXISTING_ROW);
    mockListClearanceTypes.mockResolvedValueOnce([CLEARANCE_TYPE]);
    mockRecord.mockResolvedValueOnce({ clearance_id: 'clr-1', status: 'current', expires_on: '2027-01-01' });

    await POST(post({
      action: 'verify', person_account_id: 'acct-9', clearance_type_id: 'ct-safesport', issued_on: '2026-01-01',
    }));

    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ expiresOn: '2027-01-01' }));
  });

  test('reject requires a note, and never claims a status the vocabulary does not have', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetExisting.mockResolvedValueOnce(EXISTING_ROW);
    const missingNote = await POST(post({ action: 'reject', person_account_id: 'acct-9', clearance_type_id: 'ct-safesport' }));
    expect(missingNote.status).toBe(400);
    expect(mockRecord).not.toHaveBeenCalled();

    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetExisting.mockResolvedValueOnce(EXISTING_ROW);
    mockRecord.mockResolvedValueOnce({ clearance_id: 'clr-1', status: 'not_started' });
    const res = await POST(post({
      action: 'reject', person_account_id: 'acct-9', clearance_type_id: 'ct-safesport', note: 'photo is illegible, please rescan',
    }));
    expect(res.status).toBe(200);
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({
      status: 'not_started',
      issuedOn: null,
      expiresOn: null,
      verificationNote: 'photo is illegible, please rescan',
      documentRef: EXISTING_ROW.document_ref,
    }));
  });

  test('an unknown action is refused rather than silently ignored', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetExisting.mockResolvedValueOnce(EXISTING_ROW);
    const res = await POST(post({ action: 'delete', person_account_id: 'acct-9', clearance_type_id: 'ct-safesport' }));
    expect(res.status).toBe(400);
  });
});
