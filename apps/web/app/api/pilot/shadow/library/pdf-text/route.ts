import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  LIBRARY_PDF_MAX_BYTES,
  extractLibraryPdfPages,
} from '@/src/server/pilot/libraryPdfText';
import {
  ShadowRateLimitExceeded,
  enforceShadowRateLimit,
  shadowRateLimitMessage,
} from '@/src/server/pilot/shadowRateLimit';
import { SHADOW_LIBRARY_CURATOR_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

// RINT-02. Reads a PDF the curator picked and hands back its text page by page
// so the Add Source Text panel can put ONE page's own words into an excerpt.
// Owner decision OD-2026-10-02-013, answer 4A: the app keeps only the excerpt
// the curator then submits; whole PDFs stay in the SharePoint Research Archive.
//
// WHAT THIS ROUTE DOES NOT DO, ON PURPOSE: it writes no blob, no database row
// of the file or its text, calls no Graph/SharePoint API, and logs neither the
// file name nor any text. The one write it makes is the rate-limit counter row
// (account, endpoint key, window, count): a number, nothing from the upload.
// The bytes live in this request's memory and are gone when it returns.
//
// Same curator gate as the other library write routes, because it feeds them.
// Coach, athlete, parent and signed-out callers are refused before the body is
// read. It does not touch athlete data, so no per-athlete check applies.

// Its own bucket, not 'shadow_upload': that one is the athlete-intake upload
// allowance (40 an hour) and a curator paging through papers should neither
// spend it nor be capped by it. Each read parses up to 10 MB, so it is bounded.
export const LIBRARY_PDF_TEXT_RATE_LIMIT = {
  endpointKey: 'library_pdf_text',
  limit: 60,
  windowSeconds: 3_600,
} as const;

// The multipart envelope around the file (boundary, field headers).
const MAX_REQUEST_BYTES = LIBRARY_PDF_MAX_BYTES + 1024 * 1024;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function refuse(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status, headers: NO_STORE });
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_LIBRARY_CURATOR_ROLES]);

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().startsWith('multipart/form-data;')) {
      return refuse(415, 'Send the PDF as a multipart upload.');
    }
    const rawLength = request.headers.get('content-length');
    if (!rawLength || !/^\d+$/.test(rawLength)) {
      return refuse(411, 'A bounded Content-Length is required.');
    }
    const contentLength = Number(rawLength);
    if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
      return refuse(400, 'Invalid Content-Length.');
    }
    if (contentLength > MAX_REQUEST_BYTES) {
      return refuse(413, 'PDFs up to 10 MB.');
    }

    await enforceShadowRateLimit({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      ...LIBRARY_PDF_TEXT_RATE_LIMIT,
    });

    const formData = await request.formData();
    const uploaded = formData.get('file');
    if (!(uploaded instanceof File)) {
      return refuse(400, 'Choose a PDF file.');
    }
    if (uploaded.type !== 'application/pdf') {
      return refuse(415, 'Only PDF files can be read.');
    }
    if (uploaded.size <= 0) {
      return refuse(400, 'That file is empty.');
    }
    if (uploaded.size > LIBRARY_PDF_MAX_BYTES) {
      return refuse(413, 'PDFs up to 10 MB.');
    }

    const { pages, emptyPageCount } = await extractLibraryPdfPages(new Uint8Array(await uploaded.arrayBuffer()));

    return NextResponse.json(
      { ok: true, page_count: pages.length, empty_page_count: emptyPageCount, pages },
      { status: 200, headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof ShadowRateLimitExceeded) {
      return NextResponse.json(
        { ok: false, error: shadowRateLimitMessage(error.retryAfterSeconds, 'PDF') },
        { status: 429, headers: { ...NO_STORE, 'Retry-After': String(error.retryAfterSeconds) } },
      );
    }
    return jsonError(error);
  }
}
