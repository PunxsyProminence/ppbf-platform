import { NextResponse, type NextRequest } from 'next/server';

import { getGoalsByAthlete } from '@/src/server/pilot/entities';
import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    if (!athleteId) throw new Error('Missing athlete_id');

    // Unbounded before this: SELECT * with no LIMIT over one athlete's
    // whole goal history. This route has exactly one caller and nothing
    // else depends on seeing every goal ever set, so a real default cap
    // applies here rather than the opt-in-only treatment the org-wide
    // roster/audit queries needed.
    const limit = parseSafeLimit(request.nextUrl.searchParams.get('limit'), 200, 500);
    if (limit === null) {
      return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 });
    }

    await assertActorCanAccessAthlete(principal, athleteId);
    const goals = await getGoalsByAthlete(principal.organizationId, athleteId, { limit });
    return NextResponse.json({ items: goals });
  } catch (error) {
    return jsonError(error);
  }
}
