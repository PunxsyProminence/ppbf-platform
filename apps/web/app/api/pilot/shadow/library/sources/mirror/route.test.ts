import { NextRequest } from 'next/server';

import { POST } from './route';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { getShadowLibrarySourceForMirror } from '@/src/server/pilot/shadowLibrary';
import { mirrorShadowLibrarySourceToSharePoint } from '@/src/server/pilot/shadowLibraryMirror';
import { getPipelineConfig } from '@/src/server/document-intake/config';

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

jest.mock('@/src/server/pilot/shadowLibrary', () => ({
  getShadowLibrarySourceForMirror: jest.fn(),
}));

jest.mock('@/src/server/pilot/shadowLibraryMirror', () => ({
  mirrorShadowLibrarySourceToSharePoint: jest.fn(),
}));

jest.mock('@/src/server/document-intake/config', () => ({
  getPipelineConfig: jest.fn(),
}));

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockGetForMirror = getShadowLibrarySourceForMirror as jest.MockedFunction<typeof getShadowLibrarySourceForMirror>;
const mockMirror = mirrorShadowLibrarySourceToSharePoint as jest.MockedFunction<typeof mirrorShadowLibrarySourceToSharePoint>;
const mockGetPipelineConfig = getPipelineConfig as jest.MockedFunction<typeof getPipelineConfig>;

function principal(role: PilotPrincipal['role'] = 'organization_admin'): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-real',
    athleteId: role === 'athlete' ? 'ath-1' : null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

function postRequest(body: Record<string, unknown>) {
  return new NextRequest('http://localhost/api/pilot/shadow/library/sources/mirror', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const SOURCE_RECORD = {
  source: { source_id: 'src-1', title: 'Youth safeguarding review', metadata: {} },
  documents: [],
} as unknown as NonNullable<Awaited<ReturnType<typeof getShadowLibrarySourceForMirror>>>;

describe('POST /api/pilot/shadow/library/sources/mirror', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PPBF_INGEST_MOCK_MODE;
    mockGetPipelineConfig.mockReturnValue({
      sharepoint: { tenantId: 't', clientId: 'c', clientSecret: 's', siteId: 'site', driveId: 'drive', folderPath: 'PPBF/Intake' },
    } as never);
  });

  test('a coach cannot mirror a source', async () => {
    mockRequirePrincipal.mockResolvedValue(principal('coach'));

    const response = await POST(postRequest({ source_id: 'src-1' }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockGetForMirror).not.toHaveBeenCalled();
  });

  test('a missing source_id is refused before any lookup', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());

    const response = await POST(postRequest({}));

    expect(response.status).toBe(400);
    expect(mockGetForMirror).not.toHaveBeenCalled();
  });

  test('a source that is not yet approved and verified hides as not-found', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetForMirror.mockResolvedValueOnce(null);

    const response = await POST(postRequest({ source_id: 'src-unreviewed' }));

    expect(response.status).toBe(404);
    expect(mockMirror).not.toHaveBeenCalled();
  });

  test('a valid request mirrors the source to SharePoint', async () => {
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetForMirror.mockResolvedValueOnce(SOURCE_RECORD);
    mockMirror.mockResolvedValueOnce({ itemId: 'sp-item-1', webUrl: 'https://sharepoint.example/src-1.md' });

    const response = await POST(postRequest({ source_id: 'src-1' }));
    const payload = (await response.json()) as { ok: boolean; mirror: { itemId: string } };

    expect(response.status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.mirror.itemId).toBe('sp-item-1');
    expect(mockMirror).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'site' }),
      SOURCE_RECORD.source,
      SOURCE_RECORD.documents,
      expect.any(String),
    );
  });

  test('mock mode short-circuits the real SharePoint call', async () => {
    process.env.PPBF_INGEST_MOCK_MODE = 'true';
    mockRequirePrincipal.mockResolvedValue(principal());
    mockGetForMirror.mockResolvedValueOnce(SOURCE_RECORD);

    const response = await POST(postRequest({ source_id: 'src-1' }));
    const payload = (await response.json()) as { ok: boolean; mirror: { itemId: string } };

    expect(response.status).toBe(200);
    expect(payload.mirror.itemId).toBe('mock-mirror-src-1');
    expect(mockMirror).not.toHaveBeenCalled();
  });
});
