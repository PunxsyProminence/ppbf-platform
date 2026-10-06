import { NextRequest } from 'next/server';

import { LIBRARY_PDF_MAX_BYTES } from '@/src/server/pilot/libraryPdfText';
import { requirePrincipal } from '@/src/server/pilot/http';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { ShadowRateLimitExceeded, enforceShadowRateLimit } from '@/src/server/pilot/shadowRateLimit';

import { LIBRARY_PDF_TEXT_RATE_LIMIT, POST } from './route';

// The parser is mocked, as the retired /api/document-ingest's tests did: the real one needs
// --experimental-vm-modules (see libraryPdfText.pdf.test.ts).
const mockGetText = jest.fn();
const mockDestroy = jest.fn();
const mockParserConstructed = jest.fn();
jest.mock('pdf-parse', () => ({
  PDFParse: class {
    constructor() {
      mockParserConstructed();
    }
    getText(params: unknown) {
      return mockGetText(params);
    }
    destroy() {
      return mockDestroy();
    }
  },
}));

jest.mock('@/src/server/pilot/http', () => {
  const actual = jest.requireActual('@/src/server/pilot/http');
  return { ...actual, requirePrincipal: jest.fn() };
});

// Rate limiting is the one write this route may make (a counter row), so it is
// replaced with a spy; the error class and message stay real.
jest.mock('@/src/server/pilot/shadowRateLimit', () => {
  const actual = jest.requireActual('@/src/server/pilot/shadowRateLimit');
  return { ...actual, enforceShadowRateLimit: jest.fn() };
});

// Every module through which this route could persist or forward the upload.
// Any CALL into one is recorded and throws, so a route that wrote the file or
// its text would fail twice: the throw, and the empty-list assertion below.
const persistenceCalls: string[] = [];
function tripwire(label: string) {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === '__esModule') return true;
        return () => {
          persistenceCalls.push(`${label}.${String(property)}`);
          throw new Error(`persistence reached: ${label}.${String(property)}`);
        };
      },
    },
  );
}
jest.mock('@/src/server/pilot/db', () => tripwire('db'));
jest.mock('@/src/server/pilot/blob', () => tripwire('blob'));
jest.mock('@/src/server/pilot/researchArchiveWrite', () => tripwire('researchArchiveWrite'));
jest.mock('@/src/server/pilot/shadowEvents', () => tripwire('shadowEvents'));
jest.mock('@/src/server/pilot/shadowTelemetry', () => tripwire('shadowTelemetry'));
jest.mock('@/src/server/pilot/shadowLibrary', () => tripwire('shadowLibrary'));
jest.mock('@/src/server/document-intake/audit', () => tripwire('ingestAudit'));
jest.mock('@/src/server/document-intake/sharepoint', () => tripwire('sharepoint'));
jest.mock('@/src/server/document-intake/dataverse', () => tripwire('dataverse'));
jest.mock('@/src/server/document-intake/googleDrive', () => tripwire('googleDrive'));
jest.mock('@/src/server/document-intake/auth', () => tripwire('graphAuth'));

const mockRequirePrincipal = requirePrincipal as jest.MockedFunction<typeof requirePrincipal>;
const mockEnforce = enforceShadowRateLimit as jest.MockedFunction<typeof enforceShadowRateLimit>;

function principal(role: PilotPrincipal['role']): PilotPrincipal {
  return {
    accountId: 'acct-1',
    role,
    organizationId: 'org-real',
    athleteId: null,
    sessionToken: 'token',
    authProvider: 'microsoft',
  };
}

const PDF_BYTES = Buffer.from('%PDF-1.7\nbody bytes');

async function uploadRequest(
  fileBytes: Uint8Array = PDF_BYTES,
  options: { type?: string; name?: string; omitFile?: boolean; contentLength?: string | null; contentType?: string } = {},
) {
  const form = new FormData();
  if (!options.omitFile) {
    form.append('file', new File([fileBytes as unknown as BlobPart], options.name ?? 'Neale-2024.pdf', { type: options.type ?? 'application/pdf' }));
  }
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? encoded.headers.get('content-type') ?? '',
  };
  if (options.contentLength !== null) headers['content-length'] = options.contentLength ?? String(body.length);
  return new NextRequest('http://localhost/api/pilot/shadow/library/pdf-text', { method: 'POST', headers, body });
}

let consoleSpies: jest.SpyInstance[] = [];

beforeEach(() => {
  jest.clearAllMocks();
  persistenceCalls.length = 0;
  mockRequirePrincipal.mockResolvedValue(principal('organization_admin'));
  mockEnforce.mockResolvedValue(undefined);
  mockDestroy.mockResolvedValue(undefined);
  // pdf-parse answers one page per call (libraryPdfText reads page by page):
  // `total` is the document's page count, `pages` only the page asked for.
  const documentPages = [
    { num: 1, text: 'Page one words.' },
    { num: 2, text: '' },
  ];
  mockGetText.mockImplementation(async (params?: { partial?: number[] }) => ({
    total: documentPages.length,
    pages: documentPages.filter((page) => params?.partial?.includes(page.num)),
  }));
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    jest.spyOn(console, level).mockImplementation(() => undefined),
  );
});

afterEach(() => {
  consoleSpies.forEach((spy) => spy.mockRestore());
});

describe('POST /api/pilot/shadow/library/pdf-text: who may read a PDF', () => {
  test('refuses a signed-out caller before the body is read', async () => {
    mockRequirePrincipal.mockRejectedValueOnce(new Error('Unauthorized'));

    const response = await POST(await uploadRequest());

    expect(response.status).toBe(401);
    expect(mockEnforce).not.toHaveBeenCalled();
    expect(mockParserConstructed).not.toHaveBeenCalled();
  });

  test.each(['coach', 'athlete', 'parent'] as const)('refuses %s', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal(role));

    const response = await POST(await uploadRequest());

    expect(response.status).toBe(403);
    expect(mockEnforce).not.toHaveBeenCalled();
    expect(mockParserConstructed).not.toHaveBeenCalled();
  });

  test.each(['organization_admin', 'admin', 'platform_owner'] as const)('allows %s', async (role) => {
    mockRequirePrincipal.mockResolvedValueOnce(principal(role));

    const response = await POST(await uploadRequest());

    expect(response.status).toBe(200);
  });
});

describe('POST /api/pilot/shadow/library/pdf-text: what it returns', () => {
  test('returns each page with its number and counts pages that have no text', async () => {
    const response = await POST(await uploadRequest());

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      ok: true,
      page_count: 2,
      empty_page_count: 1,
      pages: [
        { num: 1, text: 'Page one words.' },
        { num: 2, text: '' },
      ],
    });
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  test('charges its own rate-limit key, 60 an hour, to the caller', async () => {
    await POST(await uploadRequest());

    expect(LIBRARY_PDF_TEXT_RATE_LIMIT).toEqual({ endpointKey: 'library_pdf_text', limit: 60, windowSeconds: 3_600 });
    expect(mockEnforce).toHaveBeenCalledWith({
      organizationId: 'org-real',
      accountId: 'acct-1',
      endpointKey: 'library_pdf_text',
      limit: 60,
      windowSeconds: 3_600,
    });
  });

  test('answers 429 with Retry-After when the allowance is spent, without parsing', async () => {
    mockEnforce.mockRejectedValueOnce(new ShadowRateLimitExceeded(120));

    const response = await POST(await uploadRequest());

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('120');
    expect(mockParserConstructed).not.toHaveBeenCalled();
  });
});

describe('POST /api/pilot/shadow/library/pdf-text: nothing from the upload is kept', () => {
  test('touches no database, blob, archive, SharePoint, Dataverse, Drive or telemetry module', async () => {
    const response = await POST(await uploadRequest());

    expect(response.status).toBe(200);
    expect(persistenceCalls).toEqual([]);
  });

  test('writes neither the file name nor any page text to any log', async () => {
    mockGetText.mockResolvedValueOnce({ total: 1, pages: [{ num: 1, text: 'SECRET-PAGE-WORDS' }] });

    await POST(await uploadRequest(PDF_BYTES, { name: 'secret-file-name.pdf' }));
    mockGetText.mockRejectedValueOnce(new Error('parser echoed SECRET-PAGE-WORDS'));
    await POST(await uploadRequest(PDF_BYTES, { name: 'secret-file-name.pdf' }));

    const logged = consoleSpies.flatMap((spy) => spy.mock.calls).map((call) => JSON.stringify(call)).join('\n');
    expect(logged).not.toContain('SECRET-PAGE-WORDS');
    expect(logged).not.toContain('secret-file-name');
  });

  test('a parser failure answers with a fixed sentence and does not echo the file', async () => {
    mockGetText.mockRejectedValueOnce(new Error('parser echoed SECRET-PAGE-WORDS'));

    const response = await POST(await uploadRequest());
    const text = await response.text();

    expect(response.status).toBe(422);
    expect(text).not.toContain('SECRET-PAGE-WORDS');
    expect(persistenceCalls).toEqual([]);
  });
});

describe('POST /api/pilot/shadow/library/pdf-text: what it refuses', () => {
  test('a body that is not multipart', async () => {
    const response = await POST(await uploadRequest(PDF_BYTES, { contentType: 'application/pdf' }));

    expect(response.status).toBe(415);
    expect(mockParserConstructed).not.toHaveBeenCalled();
  });

  test('a request with no Content-Length', async () => {
    const response = await POST(await uploadRequest(PDF_BYTES, { contentLength: null }));

    expect(response.status).toBe(411);
    expect(mockParserConstructed).not.toHaveBeenCalled();
  });

  test.each(['abc', '0', '-5'])('a Content-Length of %s', async (contentLength) => {
    const response = await POST(await uploadRequest(PDF_BYTES, { contentLength }));

    expect([400, 411]).toContain(response.status);
    expect(mockParserConstructed).not.toHaveBeenCalled();
  });

  test('a declared size over the limit, before the body is read', async () => {
    const response = await POST(await uploadRequest(PDF_BYTES, { contentLength: String(LIBRARY_PDF_MAX_BYTES + 2 * 1024 * 1024) }));

    expect(response.status).toBe(413);
    expect(mockEnforce).not.toHaveBeenCalled();
    expect(mockParserConstructed).not.toHaveBeenCalled();
  });

  test('a file over 10 MB inside an acceptable envelope', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(LIBRARY_PDF_MAX_BYTES)]);

    const response = await POST(await uploadRequest(big));

    expect(response.status).toBe(413);
    expect(mockParserConstructed).not.toHaveBeenCalled();
  });

  test('a request without a file', async () => {
    const response = await POST(await uploadRequest(PDF_BYTES, { omitFile: true }));

    expect(response.status).toBe(400);
    expect(mockParserConstructed).not.toHaveBeenCalled();
  });

  test('a file whose declared type is not application/pdf', async () => {
    const response = await POST(await uploadRequest(PDF_BYTES, { type: 'text/html', name: 'x.html' }));

    expect(response.status).toBe(415);
    expect(mockParserConstructed).not.toHaveBeenCalled();
  });

  test('an empty file', async () => {
    const response = await POST(await uploadRequest(new Uint8Array(0)));

    expect(response.status).toBe(400);
    expect(mockParserConstructed).not.toHaveBeenCalled();
  });

  test('bytes that say application/pdf but do not start with %PDF-', async () => {
    const response = await POST(await uploadRequest(Buffer.from('<html>pretending</html>')));

    expect(response.status).toBe(400);
    expect(mockParserConstructed).not.toHaveBeenCalled();
  });
});
