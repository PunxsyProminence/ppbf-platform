import { NextRequest } from 'next/server';

import { GET } from './route';
import { downloadPilotCredentialFile } from '@/src/server/pilot/blob';
import { getPersonClearanceForOrganization } from '@/src/server/pilot/clearanceRegister';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/blob', () => ({
  downloadPilotCredentialFile: jest.fn(),
}));

jest.mock('@/src/server/pilot/clearanceRegister', () => {
  const actual = jest.requireActual('@/src/server/pilot/clearanceRegister');
  return { ...actual, getPersonClearanceForOrganization: jest.fn() };
});

const mockRequirePrincipal = requirePrincipal as jest.Mock;
const mockGetExisting = getPersonClearanceForOrganization as jest.Mock;
const mockDownload = downloadPilotCredentialFile as jest.Mock;

afterEach(() => {
  jest.clearAllMocks();
});

function principal(overrides: Partial<PilotPrincipal>): PilotPrincipal {
  return {
    accountId: 'acct-9',
    role: 'coach',
    organizationId: 'org-1',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'ppbf_local',
    ...overrides,
  } as PilotPrincipal;
}

function call(accountId: string, clearanceTypeId: string) {
  return GET(
    new NextRequest(`http://localhost/api/pilot/credentials/document/${accountId}/${clearanceTypeId}`),
    { params: Promise.resolve({ accountId, clearanceTypeId }) },
  );
}

describe('GET /api/pilot/credentials/document/[accountId]/[clearanceTypeId]', () => {
  test('401 when unauthenticated', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));
    expect((await call('acct-9', 'ct-safesport')).status).toBe(401);
  });

  test('404 (not 403) when a different, non-admin coach requests someone else\'s document', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'acct-other', role: 'coach' }));
    const res = await call('acct-9', 'ct-safesport');
    expect(res.status).toBe(404);
    expect(mockGetExisting).not.toHaveBeenCalled();
  });

  test('404 when no submission exists for that person/type', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetExisting.mockResolvedValueOnce(null);
    expect((await call('acct-9', 'ct-safesport')).status).toBe(404);
  });

  test('404 when a row exists but carries no document (never verified/uploaded)', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({}));
    mockGetExisting.mockResolvedValueOnce({ document_ref: null });
    expect((await call('acct-9', 'ct-safesport')).status).toBe(404);
  });

  test('the document owner can fetch their own document', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'acct-9', role: 'coach' }));
    mockGetExisting.mockResolvedValueOnce({ document_ref: 'org-1/acct-9/ct-safesport/credential.pdf' });
    mockDownload.mockResolvedValueOnce(Buffer.from('%PDF-1.4 fake'));

    const res = await call('acct-9', 'ct-safesport');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Cache-Control')).toMatch(/no-store/);
    expect(mockDownload).toHaveBeenCalledWith('org-1/acct-9/ct-safesport/credential.pdf');
  });

  test('an organization admin can fetch someone else\'s document', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'admin-1', role: 'organization_admin' }));
    mockGetExisting.mockResolvedValueOnce({ document_ref: 'org-1/acct-9/ct-safesport/credential.jpg' });
    mockDownload.mockResolvedValueOnce(Buffer.from('jpeg-bytes'));

    const res = await call('acct-9', 'ct-safesport');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });

  test('a plain coach (not admin, not self) is refused even for a real submission', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal({ accountId: 'acct-different', role: 'coach' }));
    const res = await call('acct-9', 'ct-safesport');
    expect(res.status).toBe(404);
    expect(mockDownload).not.toHaveBeenCalled();
  });
});
