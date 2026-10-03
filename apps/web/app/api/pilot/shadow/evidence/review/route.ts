import { NextRequest, NextResponse } from 'next/server';

import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
import { resolveLibraryShelf } from '@/src/server/pilot/libraryShelf';
import {
  completeShadowLibraryDocumentIndexing,
  listShadowLibraryReviewQueue,
  reviewShadowLibraryDocument,
  reviewShadowLibrarySource,
  type ShadowLibraryApprovalState,
} from '@/src/server/pilot/shadowLibrary';

type ReviewBody = {
  entityType?: unknown;
  entityId?: unknown;
  action?: unknown;
  approvalState?: unknown;
  shelf?: unknown;
};

// Both methods take an optional `shelf` ('gym' default, or 'platform'; a query
// parameter on GET, a body field on PATCH), resolved on the server by
// libraryShelf.ts. Only the platform owner reviews the platform shelf
// (OD-2026-10-02-013 answer 1B). Gym-shelf review is unchanged, platform owner
// included (answer 5A, "as today").

// Sources carry either prefix, and both are real. createShadowLibrarySource
// mints `source_<uuid>`, but the research corpus in
// seed-data/shadow-research/2026-08-07 is keyed `src_<hash>` -- 1,001 rows of it
// (measured 2026-10-03; this comment said 1,214 until then).
// Accepting only `source_` meant every source the importer wrote answered 404
// here, so the whole imported corpus was unreviewable and therefore permanently
// unretrievable, since retrieval requires an approved source.
const SOURCE_ID_PREFIXES = ['source_', 'src_'] as const;
const DOCUMENT_ID_PREFIXES = ['doc_'] as const;

function isLibraryId(value: unknown, prefixes: readonly string[]): value is string {
  return (
    typeof value === 'string'
    && prefixes.some((prefix) => value.startsWith(prefix))
    && value.length <= 100
    && /^[a-z0-9_-]+$/i.test(value)
  );
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'platform_owner']);
    const params = new URL(request.url).searchParams;
    const organizationId = resolveLibraryShelf(principal, params.get('shelf'), 'review');
    const rawLimit = params.get('limit');
    const limit = rawLimit === null ? 100 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      return NextResponse.json({ error: 'Invalid limit' }, { status: 400 });
    }
    const queue = await listShadowLibraryReviewQueue({
      organizationId,
      limit,
    });
    return NextResponse.json(queue);
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'platform_owner']);
    const body = await request.json() as ReviewBody;
    const organizationId = resolveLibraryShelf(principal, body.shelf, 'review');

    if (body.entityType === 'document' && body.action === 'complete_indexing') {
      if (!isLibraryId(body.entityId, DOCUMENT_ID_PREFIXES)) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      await completeShadowLibraryDocumentIndexing({
        organizationId,
        actorAccountId: principal.accountId,
        actorRole: principal.role,
        documentId: body.entityId,
      });
      return NextResponse.json({ success: true, state: 'indexed' });
    }

    if (body.action !== 'review') {
      return NextResponse.json({ error: 'Unsupported evidence review action' }, { status: 400 });
    }
    if (
      body.approvalState !== 'approved'
      && body.approvalState !== 'rejected'
      && body.approvalState !== 'pending_review'
    ) {
      return NextResponse.json({ error: 'Unsupported evidence approval state' }, { status: 400 });
    }

    const approvalState = body.approvalState as ShadowLibraryApprovalState;
    const verificationState = approvalState === 'approved' ? 'verified' : 'unverified';
    if (body.entityType === 'source' && isLibraryId(body.entityId, SOURCE_ID_PREFIXES)) {
      await reviewShadowLibrarySource({
        organizationId,
        actorAccountId: principal.accountId,
        actorRole: principal.role,
        sourceId: body.entityId,
        approvalState,
        verificationState,
      });
    } else if (body.entityType === 'document' && isLibraryId(body.entityId, DOCUMENT_ID_PREFIXES)) {
      await reviewShadowLibraryDocument({
        organizationId,
        actorAccountId: principal.accountId,
        actorRole: principal.role,
        documentId: body.entityId,
        approvalState,
        verificationState,
      });
    } else {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, approvalState, verificationState });
  } catch (error) {
    if (
      error instanceof Error
      && (
        error.message === 'SHADOW_LIBRARY_SOURCE_NOT_FOUND'
        || error.message.includes('document is missing')
      )
    ) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return jsonError(error);
  }
}
