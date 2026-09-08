import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  getAttemptForReview,
  isAttemptReviewState,
  listReviews,
  recordReview,
} from '@/src/server/pilot/trainingAttempts';

export const runtime = 'nodejs';

// BASE-06 coach attempt review. The review is a NEW adjudication mutation, and
// it is COACH-ONLY on purpose: an athlete records and reads their own attempts,
// and an admin can read them, but confirming/correcting/disputing an attempt is
// a coaching judgement. So this route does NOT reuse the wider ATTEMPT_ROLES of
// the attempts route -- an existing read capability is not authority for a new
// adjudication. Order is load-then-gate-then-write: the attempt is loaded
// within the caller's organization (a foreign or missing attempt is a hidden
// not-found), the standing athlete-access check runs on the attempt's OWN
// athlete before anything is written, and only then is the review recorded.
// The verdict for a correction is the server's, computed in recordReview from
// the attempt's stored direction -- never supplied by the caller.

const REVIEW_ROLES = ['coach'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...REVIEW_ROLES]);

    const attemptId = request.nextUrl.searchParams.get('attempt_id')?.trim();
    if (!attemptId) throw new ValidationError('Missing attempt_id.');

    const attempt = await getAttemptForReview(principal.organizationId, attemptId);
    if (!attempt) return hiddenNotFound();
    await assertActorCanAccessAthlete(principal, attempt.athlete_id);

    const items = await listReviews(principal.organizationId, attemptId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...REVIEW_ROLES]);

    const body = (await request.json()) as {
      attempt_id?: string;
      review_state?: string;
      corrected_target_value?: number | null;
      corrected_achieved_value?: number | null;
      reason?: string;
    };

    const attemptId = body.attempt_id?.trim();
    if (!attemptId) throw new ValidationError('Missing attempt_id.');
    if (!isAttemptReviewState(body.review_state)) {
      throw new ValidationError('Unknown review_state.');
    }
    const reviewState = body.review_state;

    let correctedTargetValue: number | null = null;
    let correctedAchievedValue: number | null = null;
    if (reviewState === 'corrected') {
      const achieved = body.corrected_achieved_value;
      if (typeof achieved !== 'number' || !Number.isFinite(achieved) || achieved < 0) {
        throw new ValidationError('corrected_achieved_value must be a non-negative number for a correction.');
      }
      correctedAchievedValue = achieved;
      const target = body.corrected_target_value ?? null;
      if (target !== null && (typeof target !== 'number' || !Number.isFinite(target) || target <= 0)) {
        throw new ValidationError('corrected_target_value must be a positive number when provided.');
      }
      correctedTargetValue = target;
    }

    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reviewState !== 'confirmed' && reason.length < 10) {
      throw new ValidationError('A correction or dispute needs a reason of at least 10 characters.');
    }

    // Load within the caller's organization, then gate on the attempt's own
    // athlete. A foreign or unknown attempt never reaches the access check.
    const attempt = await getAttemptForReview(principal.organizationId, attemptId);
    if (!attempt) return hiddenNotFound();
    await assertActorCanAccessAthlete(principal, attempt.athlete_id);

    const item = await recordReview({
      organizationId: principal.organizationId,
      attemptId,
      reviewState,
      correctedTargetValue,
      correctedAchievedValue,
      reason,
      reviewedByAccountId: principal.accountId,
    });

    if (!item) return hiddenNotFound();
    return NextResponse.json({ item });
  } catch (error) {
    return jsonError(error);
  }
}
