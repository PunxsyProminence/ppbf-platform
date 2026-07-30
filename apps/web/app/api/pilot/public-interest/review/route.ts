import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';
import {
  listPublicInterestSubmissions,
  updatePublicInterestSubmissionReviewState,
  type PublicInterestReviewState,
} from '@/src/server/pilot/publicInterest';

export const runtime = 'nodejs';

const REVIEW_STATES: readonly PublicInterestReviewState[] = ['new', 'contacted', 'archived'];

// Staff-facing side of the public interest intake form -- without this, real
// visitor submissions would land in a table nobody ever reads, the same
// "loop never closes" problem found elsewhere in this app's SHADOW feedback
// pipeline. organization_admin/admin/platform_owner only: this is real PII
// (name/email/phone) from prospective members, not aggregate data.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'platform_owner']);

    const url = new URL(request.url);
    const reviewStateParam = url.searchParams.get('review_state');
    if (reviewStateParam && !REVIEW_STATES.includes(reviewStateParam as PublicInterestReviewState)) {
      return NextResponse.json({ ok: false, error: 'Invalid review_state filter.' }, { status: 400 });
    }

    const limit = parseSafeLimit(url.searchParams.get('limit'), 50, 200);
    if (limit === null) {
      return NextResponse.json({ ok: false, error: 'Invalid limit.' }, { status: 400 });
    }

    const items = await listPublicInterestSubmissions({
      organizationId: principal.organizationId,
      reviewState: (reviewStateParam as PublicInterestReviewState) || undefined,
      limit,
    });

    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}

// PATCH marks a submission contacted/archived once staff has followed up --
// this is the only mutation this endpoint allows; it never edits or deletes
// what a visitor actually submitted.
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'platform_owner']);

    const body = (await request.json().catch(() => ({}))) as {
      submission_id?: unknown;
      review_state?: unknown;
    };

    if (typeof body.submission_id !== 'string' || !body.submission_id.trim()) {
      return NextResponse.json({ ok: false, error: 'submission_id is required.' }, { status: 400 });
    }
    if (
      typeof body.review_state !== 'string'
      || !REVIEW_STATES.includes(body.review_state as PublicInterestReviewState)
    ) {
      return NextResponse.json({ ok: false, error: 'A valid review_state is required.' }, { status: 400 });
    }

    const updated = await updatePublicInterestSubmissionReviewState({
      organizationId: principal.organizationId,
      submissionId: body.submission_id,
      reviewState: body.review_state as PublicInterestReviewState,
      reviewedByAccountId: principal.accountId,
    });

    if (!updated) {
      return NextResponse.json({ ok: false, error: 'Submission not found.' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, item: updated });
  } catch (error) {
    return jsonError(error);
  }
}
