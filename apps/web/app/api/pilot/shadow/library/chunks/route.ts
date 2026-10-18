import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { PilotError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { findStoredLibraryChunk, isSameLibraryChunk } from '@/src/server/pilot/libraryIntakeRecovery';
import { resolveLibraryShelf } from '@/src/server/pilot/libraryShelf';
import { trimLocator } from '@/src/server/pilot/locatorWhitespace';
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
    return typeof body.excerpt_locator === 'string' && trimLocator(body.excerpt_locator) ? trimLocator(body.excerpt_locator) : undefined;
  }
  const fromMetadata = (body.metadata as Record<string, unknown> | undefined)?.locator;
  if (fromMetadata === undefined || fromMetadata === null || fromMetadata === '') {
    return null;
  }
  // A number, boolean or object is not a locator; the trigger reads it as text
  // ('true'), so it is refused here rather than stored as full text.
  if (typeof fromMetadata !== 'string') {
    return undefined;
  }
  // Whitespace only (a tab, a line break, NBSP): refused, not read as full
  // text. The database trigger applies the same rule (CL-C1; locatorWhitespace.ts).
  return trimLocator(fromMetadata) || undefined;
}

const CHUNK_CONFLICT_CODE = 'SHADOW_LIBRARY_CHUNK_CONFLICT';
// shadowLibrary.ts EXCERPT_BUDGET_EXCEEDED_CODE, repeated so this route's
// tests can mock that module whole.
const EXCERPT_BUDGET_EXCEEDED_CODE = 'SHADOW_LIBRARY_EXCERPT_BUDGET_EXCEEDED';

// A REPEATED WRITE (L54; audit 2026-10-17 item 2). A curator's "Finish
// saving" resends parts whose first answer may have been lost after they were
// stored. The part already at this ordinal decides the answer: the same text,
// locator and separator is this write, already done -- 200 with
// already_stored, nothing written, so the document is not sent back to review
// and the excerpt budget does not count the part twice. Anything else there is
// a conflict, never reported as saved. Null: nothing is stored there yet.
async function settleRepeatedChunk(
  organizationId: string,
  documentId: string,
  ordinal: number,
  attempt: { textContent: string; excerptLocator: string | null; metadata?: Record<string, unknown> },
): Promise<NextResponse | null> {
  const stored = await findStoredLibraryChunk(organizationId, documentId, ordinal);
  if (!stored) return null;
  if (isSameLibraryChunk(stored, attempt)) {
    return NextResponse.json({ ok: true, chunk: stored, already_stored: true }, { status: 200 });
  }
  return NextResponse.json(
    { ok: false, error: 'Different text is already saved at this part of the document', code: CHUNK_CONFLICT_CODE },
    { status: 409 },
  );
}

export async function POST(request: NextRequest) {
  // Kept for the duplicate-key answer, which compares what won the race.
  let repeat: { organizationId: string; documentId: string; ordinal: number; attempt: Parameters<typeof settleRepeatedChunk>[3] } | null = null;
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

    repeat = {
      organizationId,
      documentId: body.document_id,
      ordinal: body.ordinal as number,
      attempt: {
        textContent: body.text_content,
        excerptLocator: excerptLocator || null,
        metadata: body.metadata as Record<string, unknown> | undefined,
      },
    };
    const settled = await settleRepeatedChunk(repeat.organizationId, repeat.documentId, repeat.ordinal, repeat.attempt);
    if (settled) return settled;

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
    // A repeat that raced its original past the stored-part check waits on the
    // source lock, then counts the original's part against the excerpt budget.
    // At the cap that refuses a part that is in fact saved, so the stored part
    // decides here too.
    if (repeat && error instanceof PilotError && error.code === EXCERPT_BUDGET_EXCEEDED_CODE) {
      const settled = await settleRepeatedChunk(repeat.organizationId, repeat.documentId, repeat.ordinal, repeat.attempt)
        .catch(() => null);
      if (settled) return settled;
    }
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
      // unique (document_id, ordinal): another request stored this part first.
      if (error.message.includes('duplicate key value')) {
        const settled = repeat
          ? await settleRepeatedChunk(repeat.organizationId, repeat.documentId, repeat.ordinal, repeat.attempt).catch(() => null)
          : null;
        // Not compared (the check itself failed): not a conflict, and retryable.
        return settled ?? NextResponse.json(
          { ok: false, error: 'The Library could not check the part already saved here. Try again.' },
          { status: 503 },
        );
      }
    }
    return jsonError(error);
  }
}
