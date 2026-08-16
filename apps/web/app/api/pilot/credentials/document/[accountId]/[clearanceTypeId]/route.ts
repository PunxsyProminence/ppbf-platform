import { type NextRequest } from 'next/server';

import { isOrganizationAdminRole } from '@/src/server/pilot/access';
import { downloadPilotCredentialFile } from '@/src/server/pilot/blob';
import { getPersonClearanceForOrganization } from '@/src/server/pilot/clearanceRegister';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

function contentTypeForBlobPath(blobPath: string): string {
  const match = /(\.[A-Za-z0-9]+)$/.exec(blobPath);
  return (match && CONTENT_TYPE_BY_EXTENSION[match[1].toLowerCase()]) || 'application/octet-stream';
}

/**
 * SERVE ONE CREDENTIAL DOCUMENT.
 *
 * The one path the actual bytes leave this container through -- see
 * blob.ts's header on the credentials container. No SAS URL is ever minted
 * for it: a signed URL to a background-check scan carrying an SSN is a
 * bearer capability with no idea who is holding it, and this platform
 * already refuses that trade for a portrait; a document that can carry
 * MORE sensitive data than a photograph gets no weaker a stance.
 *
 * ONLY TWO PARTIES MAY EVER REACH THIS: the document's own owner, or an
 * organization admin reviewing the verification queue. This is
 * deliberately narrower than the credential STATUS, which the product
 * owner asked to be broadly visible -- status and document are not the
 * same disclosure, and only the status one is public-trust information.
 *
 * Every refusal is the same 404 (hiddenNotFound), matching the portrait
 * route's own reasoning: telling a caller "403, this document exists but
 * you can't see it" already discloses that the document exists.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ accountId: string; clearanceTypeId: string }> },
) {
  try {
    const principal = await requirePrincipal(request);
    const { accountId, clearanceTypeId } = await params;
    if (!accountId || accountId.length > 128 || !clearanceTypeId || clearanceTypeId.length > 128) {
      return hiddenNotFound();
    }

    const isSelf = principal.accountId === accountId;
    const isAdmin = isOrganizationAdminRole(principal.role);
    if (!isSelf && !isAdmin) return hiddenNotFound();

    const row = await getPersonClearanceForOrganization(principal.organizationId, accountId, clearanceTypeId);
    if (!row || !row.document_ref) return hiddenNotFound();

    const bytes = await downloadPilotCredentialFile(row.document_ref);

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': contentTypeForBlobPath(row.document_ref),
        'Content-Length': String(bytes.byteLength),
        // no-store, not max-age: a document a person just replaced must
        // stop being served under the old bytes, and a shared cache
        // holding a background-check scan for even an hour defeats the
        // replacement.
        'Cache-Control': 'private, no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
        'Content-Disposition': 'inline',
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
