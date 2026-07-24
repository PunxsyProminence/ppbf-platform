import { NextRequest, NextResponse } from 'next/server';

import {
  hiddenNotFound,
  isUuid,
  jsonError,
  requirePrincipal,
  requireRole,
} from '@/src/server/pilot/http';
import {
  listHumanReviews,
  type ShadowReviewStatus,
  updateHumanReview,
} from '@/src/server/pilot/shadowConversations';

const REVIEW_STATUSES = new Set<ShadowReviewStatus>([
  'open',
  'in_review',
  'resolved',
  'dismissed',
]);

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'platform_owner']);
    const rawStatus = request.nextUrl.searchParams.get('status') ?? 'open';
    if (!REVIEW_STATUSES.has(rawStatus as ShadowReviewStatus)) {
      return NextResponse.json({ error: 'Unsupported review status' }, { status: 400 });
    }
    const reviews = await listHumanReviews(
      principal.organizationId,
      rawStatus as ShadowReviewStatus,
    );
    return NextResponse.json({ success: true, reviews });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'platform_owner']);
    const body = await request.json() as { reviewId?: unknown; status?: unknown };
    if (!isUuid(body.reviewId)) return hiddenNotFound();
    if (
      body.status !== 'in_review'
      && body.status !== 'resolved'
      && body.status !== 'dismissed'
    ) {
      return NextResponse.json({ error: 'Unsupported review status' }, { status: 400 });
    }
    const updated = await updateHumanReview({
      organizationId: principal.organizationId,
      reviewId: body.reviewId,
      reviewerId: principal.accountId,
      status: body.status,
    });
    if (!updated) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    return jsonError(error);
  }
}
