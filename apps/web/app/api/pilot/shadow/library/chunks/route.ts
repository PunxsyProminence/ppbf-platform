import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { resolveLibraryShelf } from '@/src/server/pilot/libraryShelf';
import { createShadowLibraryChunk } from '@/src/server/pilot/shadowLibrary';
import { rightsRefusalMessage } from '@/src/server/pilot/shadowLibraryRights';
import { SHADOW_LIBRARY_CURATOR_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

// Chunks are the unit searchShadowLibrary actually matches against and the unit
// a citation points at, so this is the endpoint that finally puts retrievable
// text in the Library.
//
// createShadowLibraryChunk deliberately resets its parent document to
// ingest_state='chunking' / approval_state='pending_review' on every insert.
// Adding text to an approved document un-approves it, because the reviewer
// approved the text they saw and not the text that arrived afterwards. That is
// why this route needs no re-approval logic of its own.
//
// An optional body `shelf` ('gym' default, or 'platform') picks the shelf,
// resolved on the server by libraryShelf.ts. A document is found only on the
// resolved shelf, so a platform chunk cannot attach to a gym document or the
// reverse.

// The chunk text is what a coach or athlete will eventually be shown as
// evidence, and it is stored verbatim. Postgres would accept a multi-megabyte
// value; bounding it here keeps a single request from writing a chunk far
// larger than anything the search snippet path is built to render.
const MAX_CHUNK_LENGTH = 20_000;
const MAX_ORDINAL = 100_000;
const MAX_LOCATOR_LENGTH = 200;

// Rights (OD-2026-10-03-002 section 3; OD-2026-10-02-013 answer 4A). A chunk
// with `excerpt_locator` (where in the source it is: a page, section or
// timestamp) is an excerpt, which any source may hold; one without is full
// text, which the database refuses unless the document's source is ppbf_owned
// or open_licence (422 below). The /evidence intake already files a `locator`
// in metadata, and that counts when the body names none, so a page loaded
// before this route learned the field still saves excerpts.
function excerptLocatorFrom(body: { excerpt_locator?: unknown; metadata?: unknown }): string | null | undefined {
  if (body.excerpt_locator !== undefined && body.excerpt_locator !== null) {
    // A blank locator says nothing about where the text is: refused, not read as full text.
    return typeof body.excerpt_locator === 'string' && body.excerpt_locator.trim() ? body.excerpt_locator.trim() : undefined;
  }
  const fromMetadata = (body.metadata as Record<string, unknown> | undefined)?.locator;
  return typeof fromMetadata === 'string' ? fromMetadata.trim() : null;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_LIBRARY_CURATOR_ROLES]);

    const body = (await request.json().catch(() => ({}))) as {
      document_id?: unknown;
      ordinal?: unknown;
      text_content?: unknown;
      metadata?: unknown;
      excerpt_locator?: unknown;
      shelf?: unknown;
    };
    const organizationId = resolveLibraryShelf(principal, body.shelf, 'write');

    if (typeof body.document_id !== 'string' || !body.document_id.trim()) {
      return NextResponse.json({ ok: false, error: 'Missing document_id' }, { status: 400 });
    }

    if (!Number.isSafeInteger(body.ordinal) || (body.ordinal as number) < 0 || (body.ordinal as number) > MAX_ORDINAL) {
      return NextResponse.json(
        { ok: false, error: `ordinal must be an integer between 0 and ${MAX_ORDINAL}` },
        { status: 400 },
      );
    }

    if (typeof body.text_content !== 'string' || !body.text_content.trim()) {
      return NextResponse.json({ ok: false, error: 'Missing text_content' }, { status: 400 });
    }

    if (body.text_content.length > MAX_CHUNK_LENGTH) {
      return NextResponse.json(
        { ok: false, error: `text_content must be ${MAX_CHUNK_LENGTH} characters or fewer` },
        { status: 400 },
      );
    }

    if (
      body.metadata !== undefined
      && (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))
    ) {
      return NextResponse.json({ ok: false, error: 'metadata must be an object' }, { status: 400 });
    }

    const excerptLocator = excerptLocatorFrom(body);
    if (excerptLocator === undefined || (excerptLocator !== null && excerptLocator.length > MAX_LOCATOR_LENGTH)) {
      return NextResponse.json(
        { ok: false, error: `excerpt_locator must be non-blank text of ${MAX_LOCATOR_LENGTH} characters or fewer` },
        { status: 400 },
      );
    }

    const chunk = await createShadowLibraryChunk({
      organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      documentId: body.document_id,
      ordinal: body.ordinal as number,
      textContent: body.text_content,
      excerptLocator: excerptLocator || null,
      metadata: body.metadata as Record<string, unknown> | undefined,
    });

    return NextResponse.json({ ok: true, chunk }, { status: 201 });
  } catch (error) {
    const refusal = rightsRefusalMessage(error);
    if (refusal) {
      return NextResponse.json({ ok: false, error: refusal }, { status: 422 });
    }
    if (error instanceof Error) {
      // Same disclosure rule as the documents route: a document in another
      // organization reads as absent rather than as forbidden.
      if (error.message === 'Document does not exist in this organization.') {
        return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
      }
      // unique (document_id, ordinal)
      if (error.message.includes('duplicate key value')) {
        return NextResponse.json(
          { ok: false, error: 'A chunk with this ordinal already exists for this document' },
          { status: 409 },
        );
      }
    }
    return jsonError(error);
  }
}
