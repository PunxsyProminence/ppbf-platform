import { NextRequest, NextResponse } from 'next/server';

import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';
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
};

function isLibraryId(value: unknown, prefix: 'source_' | 'doc_'): value is string {
  return (
    typeof value === 'string'
    && value.startsWith(prefix)
    && value.length <= 100
    && /^[a-z0-9_-]+$/i.test(value)
  );
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'platform_owner']);
    const rawLimit = new URL(request.url).searchParams.get('limit');
    const limit = rawLimit === null ? 100 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
      return NextResponse.json({ error: 'Invalid limit' }, { status: 400 });
    }
    const queue = await listShadowLibraryReviewQueue({
      organizationId: principal.organizationId,
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

    if (body.entityType === 'document' && body.action === 'complete_indexing') {
      if (!isLibraryId(body.entityId, 'doc_')) {
        return NextResponse.json({ error: 'Not found' }, { status: 404 });
      }
      await completeShadowLibraryDocumentIndexing({
        organizationId: principal.organizationId,
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
    if (body.entityType === 'source' && isLibraryId(body.entityId, 'source_')) {
      await reviewShadowLibrarySource({
        organizationId: principal.organizationId,
        actorAccountId: principal.accountId,
        actorRole: principal.role,
        sourceId: body.entityId,
        approvalState,
        verificationState,
      });
    } else if (body.entityType === 'document' && isLibraryId(body.entityId, 'doc_')) {
      await reviewShadowLibraryDocument({
        organizationId: principal.organizationId,
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
