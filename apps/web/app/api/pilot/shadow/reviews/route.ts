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
  loadHumanReviewExchange,
  type ShadowReviewStatus,
  updateHumanReview,
} from '@/src/server/pilot/shadowConversations';

// OD-2026-10-05-024 ruling 3: the chat human-review queue is gym business.
// platform_owner is not in this list -- it cannot access organization-private
// athlete records by default (access.ts assertActorCanAccessAthlete).
const SHADOW_REVIEW_QUEUE_ROLES = ['organization_admin', 'admin'] as const;

const REVIEW_STATUSES = new Set<ShadowReviewStatus>([
  'open',
  'in_review',
  'resolved',
  'dismissed',
]);

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...SHADOW_REVIEW_QUEUE_ROLES]);

    // ?reviewId=<uuid>: the one exchange behind that ticket, and nothing else
    // from the chat (OD-2026-10-07-009 question card 2 item 4, "That one
    // exchange"). The read is recorded against the caller in
    // pilot.audit_events before the words are returned. The ticket is the
    // only handle: there is no message or conversation parameter, and a
    // ticket outside the caller's organization is a 404 that says nothing.
    const reviewId = request.nextUrl.searchParams.get('reviewId');
    if (reviewId !== null) {
      if (!isUuid(reviewId)) return hiddenNotFound();
      const exchange = await loadHumanReviewExchange({
        organizationId: principal.organizationId,
        reviewId,
        reader: { accountId: principal.accountId, role: principal.role },
      });
      if (!exchange) return hiddenNotFound();
      return NextResponse.json({ success: true, exchange });
    }

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
    requireRole(principal, [...SHADOW_REVIEW_QUEUE_ROLES]);
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
