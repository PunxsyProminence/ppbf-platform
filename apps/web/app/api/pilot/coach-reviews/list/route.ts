import { NextResponse, type NextRequest } from 'next/server';

import { getCoachReviewsBySession, getSessionById } from '@/src/server/pilot/entities';
import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

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
      throw new Error('Session not found');
    }

    await assertActorCanAccessAthlete(principal, session.athlete_id);
    const reviews = await getCoachReviewsBySession(principal.organizationId, sessionId);
    return NextResponse.json({ items: reviews });
  } catch (error) {
    return jsonError(error);
  }
}
