import { NextResponse, type NextRequest } from 'next/server';

import { getCoachReviewsBySession, getSessionById } from '@/src/server/pilot/entities';
import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { isFamilyRecordCaller, toFamilyCoachReviews } from '@/src/server/pilot/familyRecordView';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete']);

    const sessionId = request.nextUrl.searchParams.get('session_id');
    if (!sessionId) throw new Error('Missing session_id');

    // Get session to verify athlete_id for access control
    const session = await getSessionById(principal.organizationId, sessionId);
    if (!session) {
      return hiddenNotFound();
    }

    await assertActorCanAccessAthlete(principal, session.athlete_id);
    const reviews = await getCoachReviewsBySession(principal.organizationId, sessionId);

    // An athlete reading the reviews of their own session gets the family
    // shape: coach_name in place of coach_id (OD-2026-10-06-025 ruling 2).
    // Staff keep the row.
    if (isFamilyRecordCaller(principal.role)) {
      return NextResponse.json({ items: await toFamilyCoachReviews(principal.organizationId, reviews) });
    }

    return NextResponse.json({ items: reviews });
  } catch (error) {
    return jsonError(error);
  }
}
