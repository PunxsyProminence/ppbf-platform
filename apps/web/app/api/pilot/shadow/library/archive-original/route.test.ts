import { NextRequest } from 'next/server';

import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { ConflictError } from '@/src/server/pilot/errors';
import { requirePrincipal } from '@/src/server/pilot/http';
import { LIBRARY_PDF_MAX_BYTES } from '@/src/server/pilot/libraryPdfText';
import { readResearchArchiveSetup } from '@/src/server/pilot/researchArchiveConfig';
import { fileResearchOriginal } from '@/src/server/pilot/researchArchiveFiling';
import { enforceShadowRateLimit } from '@/src/server/pilot/shadowRateLimit';

import { GET, LIBRARY_ARCHIVE_ORIGINAL_RATE_LIMIT, POST } from './route';

// The route's own decisions: who may call it, when it is OFF, what reaches the
// filing module, and how the answer reads. Filing itself (database + Graph) is
// researchArchiveFiling.pg.test.ts; here it is a spy.

jest.mock('pdf-parse', () => ({ PDFParse: class {} }));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});
jest.mock('@/src/server/pilot/shadowRateLimit', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowRateLimit');
  return { ...actual, enforceShadowRateLimit: jest.fn() };
});
jest.mock('@/src/server/pilot/researchArchiveConfig', () => ({ readResearchArchiveSetup: jest.fn() }));
jest.mock('@/src/server/pilot/researchArchiveFiling', () => ({ fileResearchOriginal: jest.fn() }));

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockEnforce = enforceShadowRateLimit as jest.MockedFunction<typeof enforceShadowRateLimit>;
const mockSetup = readResearchArchiveSetup as jest.MockedFunction<typeof readResearchArchiveSetup>;
const mockFile = fileResearchOriginal as jest.MockedFunction<typeof fileResearchOriginal>;

const FILERS = ['org-real', '__platform__'] as const;
const CONFIG = { siteId: 'site', driveId: 'drive', archiveRootItemId: 'root', getAccessToken: async () => 'token' };
const PDF_BYTES = Buffer.from('%PDF-1.7\nbody bytes');

const ROW = {
  archived_original_id: 'arc_1',
  organization_id: 'org-real',
  source_id: 'src_1',
  provider: 'sharepoint' as const,
  site_id: 'site',
  drive_id: 'drive',
  item_id: 'item',
  web_url: 'https://sp/x.pdf',
  archive_root_item_id: 'root',
  archive_domain_code: 'R19',
  archive_filename: 'Paper--0123456789ab.pdf',
  original_filename: 'Paper.pdf',
  content_sha256: 'a'.repeat(64),
  byte_size: '19',
  acquisition_provider: 'Penn State University Libraries',
  acquisition_channel: 'library_database' as const,
  acquired_at: new Date('2026-10-17T00:00:00.000Z'),
  version_kind: 'version_of_record' as const,
  supersedes_archived_original_id: null,
  created_by_account_id: 'acct-1',
  created_by_role: 'organization_admin',
  created_at: new Date('2026-10-17T00:00:00.000Z'),
};

function principal(role: PilotPrincipal['role']): PilotPrincipal {
  return { accountId: 'acct-1', role, organizationId: 'org-real', athleteId: null, sessionToken: 'token', authProvider: 'microsoft' };
}

async function uploadRequest(
  fields: Record<string, string> = {},
  options: { type?: string; omitFile?: boolean; contentLength?: string } = {},
) {
  const form = new FormData();
  if (!options.omitFile) {
    form.append('file', new File([PDF_BYTES as unknown as BlobPart], 'Paper.pdf', { type: options.type ?? 'application/pdf' }));
  }
  for (const [name, value] of Object.entries({
    source_id: 'src_1',
    acquisition_provider: 'Penn State University Libraries',
    acquisition_channel: 'library_database',
    version_kind: 'version_of_record',
    ...fields,
  })) {
    form.append(name, value);
  }
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  return new NextRequest('http://localhost/api/pilot/shadow/library/archive-original', {
    method: 'POST',
    headers: {
      'content-type': encoded.headers.get('content-type') ?? '',
      'content-length': options.contentLength ?? String(body.length),
    },
    body,
  });
}

function getRequest(shelf: string | null = null) {
  return new NextRequest(`http://localhost/api/pilot/shadow/library/archive-original${shelf ? `?shelf=${shelf}` : ''}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
  mockSetup.mockReturnValue({ state: 'ready', config: CONFIG, filingOrganizationIds: FILERS });
  mockFile.mockResolvedValue({ status: 'filed', original: ROW });
});

describe('who may file', () => {
  test.each(['coach', 'athlete', 'parent'] as const)('refuses %s before reading anything', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal(role));

    const response = await POST(await uploadRequest());

    expect(response.status).toBe(403);
    expect(mockEnforce).not.toHaveBeenCalled();
    expect(mockFile).not.toHaveBeenCalled();
  });

  test('the platform owner may not file to a gym shelf', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await POST(await uploadRequest());

    expect(response.status).toBe(403);
    expect(mockFile).not.toHaveBeenCalled();
  });

  test('the platform owner files to the platform shelf', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('platform_owner'));

    const response = await POST(await uploadRequest({ shelf: 'platform' }));

    expect(response.status).toBe(201);
    expect(mockFile).toHaveBeenCalledWith(expect.objectContaining({ organizationId: '__platform__' }));
  });

  test('a gym admin cannot name the platform shelf', async () => {
    const response = await POST(await uploadRequest({ shelf: 'platform' }));

    expect(response.status).toBe(403);
    expect(mockFile).not.toHaveBeenCalled();
  });
});

describe('when filing is not switched on', () => {
  test('OFF answers 503 ARCHIVE_NOT_CONFIGURED and charges nothing', async () => {
    mockSetup.mockReturnValue({ state: 'off' });

    const response = await POST(await uploadRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ ok: false, code: 'ARCHIVE_NOT_CONFIGURED' });
    expect(mockEnforce).not.toHaveBeenCalled();
    expect(mockFile).not.toHaveBeenCalled();
  });

  test('half-configured answers the generic 503 and names no setting', async () => {
    mockSetup.mockReturnValue({ state: 'incomplete', missing: ['RESEARCH_ARCHIVE_DRIVE_ID'] });
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await POST(await uploadRequest());
      const body = JSON.stringify(await response.json());

      expect(response.status).toBe(503);
      expect(body).not.toContain('RESEARCH_ARCHIVE');
      expect(log).toHaveBeenCalledWith(expect.stringContaining('RESEARCH_ARCHIVE_DRIVE_ID'));
      expect(mockFile).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  test.each([
    ['ready, this gym files', { state: 'ready', config: CONFIG, filingOrganizationIds: FILERS }, 'organization_admin', null, 'on'],
    ['ready, another gym', { state: 'ready', config: CONFIG, filingOrganizationIds: ['org-other'] }, 'organization_admin', null, 'off'],
    ['ready, platform owner on the platform shelf', { state: 'ready', config: CONFIG, filingOrganizationIds: FILERS }, 'platform_owner', 'platform', 'on'],
    ['ready, platform owner on a gym shelf', { state: 'ready', config: CONFIG, filingOrganizationIds: FILERS }, 'platform_owner', null, 'off'],
    ['off', { state: 'off' }, 'organization_admin', null, 'off'],
    ['half-configured', { state: 'incomplete', missing: ['RESEARCH_ARCHIVE_SITE_ID'] }, 'organization_admin', null, 'unavailable'],
  ] as const)('GET tells a curator whether their shelf files here (%s)', async (_label, setup, role, shelf, archive) => {
    mockSetup.mockReturnValue(setup as never);
    mockRequirePrincipal.mockResolvedValueOnce(principal(role));
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await GET(getRequest(shelf));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, archive });
    } finally {
      log.mockRestore();
    }
  });

  test('GET is for curators only', async () => {
    mockRequirePrincipal.mockResolvedValueOnce(principal('coach'));

    expect((await GET(getRequest())).status).toBe(403);
  });
});

describe('the upload', () => {
  test('a non-PDF type is refused', async () => {
    const response = await POST(await uploadRequest({}, { type: 'text/plain' }));

    expect(response.status).toBe(415);
    expect(mockFile).not.toHaveBeenCalled();
  });

  test('no file is refused', async () => {
    expect((await POST(await uploadRequest({}, { omitFile: true }))).status).toBe(400);
    expect(mockFile).not.toHaveBeenCalled();
  });

  test('an oversized request is refused before it is read', async () => {
    const response = await POST(await uploadRequest({}, { contentLength: String(LIBRARY_PDF_MAX_BYTES + 2 * 1024 * 1024) }));

    expect(response.status).toBe(413);
    expect(mockEnforce).not.toHaveBeenCalled();
  });

  test('charges its own rate-limit key, 30 an hour, to the caller', async () => {
    await POST(await uploadRequest());

    expect(LIBRARY_ARCHIVE_ORIGINAL_RATE_LIMIT).toEqual({ endpointKey: 'library_archive_original', limit: 30, windowSeconds: 3_600 });
    expect(mockEnforce).toHaveBeenCalledWith({ organizationId: 'org-real', accountId: 'acct-1', ...LIBRARY_ARCHIVE_ORIGINAL_RATE_LIMIT });
  });

  test('passes the file, its name and the provenance fields to filing', async () => {
    await POST(await uploadRequest({ acquired_at: '2026-09-01', supersedes_archived_original_id: 'arc_0' }));

    expect(mockFile).toHaveBeenCalledTimes(1);
    const input = mockFile.mock.calls[0][0];
    expect(input).toMatchObject({
      config: CONFIG,
      filingOrganizationIds: FILERS,
      organizationId: 'org-real',
      actorAccountId: 'acct-1',
      actorRole: 'organization_admin',
      sourceId: 'src_1',
      originalFilename: 'Paper.pdf',
      acquisitionProvider: 'Penn State University Libraries',
      acquisitionChannel: 'library_database',
      acquiredAt: '2026-09-01',
      versionKind: 'version_of_record',
      supersedesArchivedOriginalId: 'arc_0',
    });
    expect(Buffer.from(input.fileBytes).equals(PDF_BYTES)).toBe(true);
  });
});

describe('the answer', () => {
  test('a new filing is 201 with the archive identity the panel needs', async () => {
    const response = await POST(await uploadRequest());

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      ok: true,
      status: 'filed',
      archived_original: {
        archived_original_id: 'arc_1',
        source_id: 'src_1',
        archive_domain_code: 'R19',
        archive_filename: 'Paper--0123456789ab.pdf',
        web_url: 'https://sp/x.pdf',
        content_sha256: 'a'.repeat(64),
        version_kind: 'version_of_record',
      },
    });
  });

  test('the same PDF again is 200 already_filed', async () => {
    mockFile.mockResolvedValueOnce({ status: 'already_filed', original: ROW });

    const response = await POST(await uploadRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, status: 'already_filed' });
  });

  test('a refusal from filing keeps its status and code', async () => {
    mockFile.mockRejectedValueOnce(new ConflictError('Classify this source first.', 'SOURCE_NOT_CLASSIFIED'));

    const response = await POST(await uploadRequest());

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'Classify this source first.', code: 'SOURCE_NOT_CLASSIFIED' });
  });
});
