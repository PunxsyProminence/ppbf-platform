import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { getCoachReviewById, getSessionAthleteId } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'coach']);

    const body = (await request.json()) as { review_id?: string };
    const reviewId = body.review_id?.trim() || '';
    if (!reviewId) {
      throw new Error('Missing review_id');
    }

    const review = await getCoachReviewById(reviewId);
    if (!review) {
      return NextResponse.json({ found: false });
    }

    const athleteId = await getSessionAthleteId(review.session_id);
    if (!athleteId) {
      throw new Error('Missing session for coach review');
    }

    await assertActorCanAccessAthlete(principal, athleteId);
    return NextResponse.json({ found: true, review, athlete_id: athleteId });
  } catch (error) {
    return jsonError(error);
  }
}
