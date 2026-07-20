import { NextRequest, NextResponse } from 'next/server';
import { requirePrincipal, jsonError } from '@/src/server/pilot/http';
import { requireRole } from '@/src/server/pilot/access';
import { listHumanReviews, updateHumanReview } from '@/src/server/pilot/shadowConversations';

export const runtime = 'nodejs';
const REVIEW_ROLES = ['admin', 'organization_admin', 'platform_owner'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...REVIEW_ROLES]);
    const status = new URL(request.url).searchParams.get('status') ?? 'open';
    if (!['open', 'in_review', 'resolved', 'dismissed'].includes(status)) {
      return NextResponse.json({ success: false, error: 'Invalid review status.' }, { status: 400 });
    }
    return NextResponse.json({ success: true, reviews: await listHumanReviews(principal.organizationId, status) });
  } catch (error) {
    return jsonError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...REVIEW_ROLES]);
    const body = await request.json();
    if (typeof body.reviewId !== 'string' || !['in_review', 'resolved', 'dismissed'].includes(body.status)) {
      return NextResponse.json({ success: false, error: 'reviewId and a valid status are required.' }, { status: 400 });
    }
    const updated = await updateHumanReview({
      organizationId: principal.organizationId,
      reviewId: body.reviewId,
      reviewerId: principal.accountId,
      status: body.status,
    });
    return updated ? NextResponse.json({ success: true }) : NextResponse.json({ success: false, error: 'Review item not found.' }, { status: 404 });
  } catch (error) {
    return jsonError(error);
  }
}
