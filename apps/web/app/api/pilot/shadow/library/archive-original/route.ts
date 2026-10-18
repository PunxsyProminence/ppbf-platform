import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import type { PilotPrincipal } from '@/src/server/pilot/auth';
import { ForbiddenError, SERVICE_UNAVAILABLE_MESSAGE, ServiceUnavailableError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { resolveLibraryShelf } from '@/src/server/pilot/libraryShelf';
import { LIBRARY_PDF_MAX_BYTES } from '@/src/server/pilot/libraryPdfText';
import { readResearchArchiveSetup } from '@/src/server/pilot/researchArchiveConfig';
import { fileResearchOriginal } from '@/src/server/pilot/researchArchiveFiling';
import {
  ShadowRateLimitExceeded,
  enforceShadowRateLimit,
  shadowRateLimitMessage,
} from '@/src/server/pilot/shadowRateLimit';
import { SHADOW_LIBRARY_CURATOR_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

// Files a research PDF in the SharePoint Research Archive and records where it
// went (issue #345; lane L57). The PDF goes to SharePoint and nowhere else:
// no blob, no database copy of the file or its text (OD-2026-10-02-013 4A).
// The row it writes is the archive identity in
// pilot.shadow_library_archived_originals; researchArchiveFiling.ts has the
// order of operations and why nothing is ever filed twice.
//
// Same curator gate and shelf rule as the other library write routes: the
// platform owner files to the platform shelf only, a gym's admin to the gym's
// (OD-2026-10-02-015 D3). Not athlete data.
//
// OFF unless this deployment is configured (researchArchiveConfig.ts); only
// production is, and only for the shelves it names. GET says whether the
// caller's shelf (?shelf=platform for the platform shelf) files here, so the
// screen can offer filing or not.

export const LIBRARY_ARCHIVE_ORIGINAL_RATE_LIMIT = {
  endpointKey: 'library_archive_original',
  limit: 30,
  windowSeconds: 3_600,
} as const;

// The multipart envelope around the file (boundary, field headers, the text fields).
const MAX_REQUEST_BYTES = LIBRARY_PDF_MAX_BYTES + 1024 * 1024;

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

function refuse(status: number, error: string, code?: string) {
  return NextResponse.json({ ok: false, error, ...(code ? { code } : {}) }, { status, headers: NO_STORE });
}

function textField(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === 'string' ? value : null;
}

/** Whether THIS shelf files here: off for a shelf the caller cannot write or the archive does not take. */
function archiveState(principal: PilotPrincipal, shelf: string | null): 'on' | 'off' | 'unavailable' {
  const setup = readResearchArchiveSetup();
  if (setup.state === 'off') return 'off';
  if (setup.state === 'incomplete') {
    console.error(`Research archive is half-configured; missing: ${setup.missing.join(', ')}`);
    return 'unavailable';
  }
  let organizationId: string;
  try {
    organizationId = resolveLibraryShelf(principal, shelf ?? undefined, 'write');
  } catch (error) {
    if (error instanceof ForbiddenError) return 'off';
    throw error;
  }
  return setup.filingOrganizationIds.includes(organizationId) ? 'on' : 'off';
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_LIBRARY_CURATOR_ROLES]);
    const archive = archiveState(principal, request.nextUrl.searchParams.get('shelf'));
    return NextResponse.json({ ok: true, archive }, { status: 200, headers: NO_STORE });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_LIBRARY_CURATOR_ROLES]);

    const setup = readResearchArchiveSetup();
    if (setup.state === 'off') {
      return refuse(503, 'Filing in the Research Archive is not switched on here.', 'ARCHIVE_NOT_CONFIGURED');
    }
    if (setup.state === 'incomplete') {
      console.error(`Research archive is half-configured; missing: ${setup.missing.join(', ')}`);
      throw new ServiceUnavailableError(SERVICE_UNAVAILABLE_MESSAGE, 'ARCHIVE_MISCONFIGURED');
    }

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
      ...LIBRARY_ARCHIVE_ORIGINAL_RATE_LIMIT,
    });

    const formData = await request.formData();
    const organizationId = resolveLibraryShelf(principal, textField(formData, 'shelf') ?? undefined, 'write');
    const uploaded = formData.get('file');
    if (!(uploaded instanceof File)) {
      return refuse(400, 'Choose a PDF file.');
    }
    if (uploaded.type !== 'application/pdf') {
      return refuse(415, 'Only PDF files can be filed.');
    }
    if (uploaded.size > LIBRARY_PDF_MAX_BYTES) {
      return refuse(413, 'PDFs up to 10 MB.');
    }

    const result = await fileResearchOriginal({
      config: setup.config,
      filingOrganizationIds: setup.filingOrganizationIds,
      organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      sourceId: textField(formData, 'source_id') ?? '',
      originalFilename: uploaded.name,
      fileBytes: new Uint8Array(await uploaded.arrayBuffer()),
      acquisitionProvider: textField(formData, 'acquisition_provider') ?? '',
      acquisitionChannel: textField(formData, 'acquisition_channel') ?? '',
      acquiredAt: textField(formData, 'acquired_at'),
      versionKind: textField(formData, 'version_kind'),
      supersedesArchivedOriginalId: textField(formData, 'supersedes_archived_original_id'),
    });

    const original = result.original;
    return NextResponse.json(
      {
        ok: true,
        status: result.status,
        archived_original: {
          archived_original_id: original.archived_original_id,
          source_id: original.source_id,
          archive_domain_code: original.archive_domain_code,
          archive_filename: original.archive_filename,
          web_url: original.web_url,
          content_sha256: original.content_sha256,
          version_kind: original.version_kind,
        },
      },
      { status: result.status === 'filed' ? 201 : 200, headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof ShadowRateLimitExceeded) {
      return NextResponse.json(
        { ok: false, error: shadowRateLimitMessage(error.retryAfterSeconds, 'PDF') },
        { status: 429, headers: { ...NO_STORE, 'Retry-After': String(error.retryAfterSeconds) } },
      );
    }
    if (error instanceof Error && (error as Error & { cause?: unknown }).cause !== undefined) {
      const cause = (error as Error & { cause?: unknown }).cause;
      // Graph's own error text, for whoever reads the log; never sent to the caller. Capped.
      console.error(`Research archive filing failed: ${(cause instanceof Error ? cause.message : String(cause)).slice(0, 500)}`);
    }
    return jsonError(error);
  }
}
