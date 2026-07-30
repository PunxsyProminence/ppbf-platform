import { NextResponse, type NextRequest } from 'next/server';

import { getGoalsByAthlete } from '@/src/server/pilot/entities';
import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    if (!athleteId) throw new Error('Missing athlete_id');

    await assertActorCanAccessAthlete(principal, athleteId);
    const goals = await getGoalsByAthlete(principal.organizationId, athleteId);
    return NextResponse.json({ items: goals });
  } catch (error) {
    return jsonError(error);
  }
}
