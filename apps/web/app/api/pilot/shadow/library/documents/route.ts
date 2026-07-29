import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  createShadowLibraryDocument,
  type ShadowLibraryIngestState,
} from '@/src/server/pilot/shadowLibrary';
import { SHADOW_LIBRARY_CURATOR_ROLES } from '@/src/server/pilot/shadowRoleSets';

export const runtime = 'nodejs';

// Registers a document against an already-registered source. Like the sources
// route, this does not make anything citable: createShadowLibraryDocument
// leaves approval_state='pending_review', and searchShadowLibrary additionally
// requires ingest_state='indexed' with index_completed_at set, which only
// PATCH /shadow/evidence/review can produce.

const INGEST_STATES: Record<ShadowLibraryIngestState, true> = {
  pending: true,
  extracting: true,
  chunking: true,
  embedding: true,
  indexed: true,
  failed: true,
  quarantined: true,
};

function isIngestState(value: unknown): value is ShadowLibraryIngestState {
  return typeof value === 'string' && Object.hasOwn(INGEST_STATES, value);
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_LIBRARY_CURATOR_ROLES]);

    const body = (await request.json().catch(() => ({}))) as {
      source_id?: unknown;
      document_name?: unknown;
      subject_id?: unknown;
      blob_path?: unknown;
      content_sha256?: unknown;
      ingest_state?: unknown;
      metadata?: unknown;
    };

    if (typeof body.source_id !== 'string' || !body.source_id.trim()) {
      return NextResponse.json({ ok: false, error: 'Missing source_id' }, { status: 400 });
    }

    if (typeof body.document_name !== 'string' || !body.document_name.trim()) {
      return NextResponse.json({ ok: false, error: 'Missing document_name' }, { status: 400 });
    }

    if (body.subject_id !== undefined && body.subject_id !== null && typeof body.subject_id !== 'string') {
      return NextResponse.json({ ok: false, error: 'subject_id must be a string' }, { status: 400 });
    }

    if (body.blob_path !== undefined && body.blob_path !== null && typeof body.blob_path !== 'string') {
      return NextResponse.json({ ok: false, error: 'blob_path must be a string' }, { status: 400 });
    }

    if (
      body.content_sha256 !== undefined
      && body.content_sha256 !== null
      && (typeof body.content_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(body.content_sha256))
    ) {
      return NextResponse.json({ ok: false, error: 'content_sha256 must be a hex sha-256 digest' }, { status: 400 });
    }

    // Accepting 'indexed' here would let a caller skip the review gate outright:
    // searchShadowLibrary keys on ingest_state='indexed' plus index_completed_at,
    // and completeShadowLibraryDocumentIndexing is what is supposed to set both
    // together after an evidence reviewer approves. A document that arrives
    // claiming to be indexed has never been reviewed.
    if (body.ingest_state !== undefined && !isIngestState(body.ingest_state)) {
      return NextResponse.json({ ok: false, error: 'Unsupported ingest_state' }, { status: 400 });
    }

    if (body.ingest_state === 'indexed') {
      return NextResponse.json(
        { ok: false, error: 'ingest_state "indexed" is set by evidence review, not by document registration' },
        { status: 400 },
      );
    }

    if (
      body.metadata !== undefined
      && (typeof body.metadata !== 'object' || body.metadata === null || Array.isArray(body.metadata))
    ) {
      return NextResponse.json({ ok: false, error: 'metadata must be an object' }, { status: 400 });
    }

    // A subject_id makes this document athlete-scoped, and chunks inherit the
    // subject from their document. Curating organization doctrine and writing
    // evidence about a named athlete are different acts: this refuses
    // platform_owner outright and holds a coach to their assigned athletes,
    // which is the same check searchShadowLibrary runs on the way back out.
    const subjectId = (body.subject_id as string | null | undefined)?.trim() || null;
    if (subjectId) {
      await assertActorCanAccessAthlete(principal, subjectId);
    }

    const document = await createShadowLibraryDocument({
      organizationId: principal.organizationId,
      actorAccountId: principal.accountId,
      actorRole: principal.role,
      sourceId: body.source_id,
      documentName: body.document_name,
      subjectId,
      blobPath: (body.blob_path as string | null | undefined) ?? null,
      contentSha256: (body.content_sha256 as string | null | undefined) ?? null,
      ingestState: body.ingest_state as ShadowLibraryIngestState | undefined,
      metadata: body.metadata as Record<string, unknown> | undefined,
    });

    return NextResponse.json({ ok: true, document }, { status: 201 });
  } catch (error) {
    if (error instanceof Error) {
      // Naming a source in another organization must be indistinguishable from
      // naming one that does not exist, or this route confirms the existence of
      // other organizations' sources by id.
      if (error.message === 'Source does not exist in this organization.') {
        return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
      }
      // unique (organization_id, content_sha256): the same content is already
      // registered, which is the seed script re-running rather than a fault.
      if (error.message.includes('duplicate key value')) {
        return NextResponse.json(
          { ok: false, error: 'A document with this content hash is already registered in this organization' },
          { status: 409 },
        );
      }
    }
    return jsonError(error);
  }
}
