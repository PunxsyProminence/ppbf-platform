import { NextResponse, type NextRequest } from 'next/server';

import { getGoalsByAthlete } from '@/src/server/pilot/entities';
import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { readsFullGoals, toFamilySmartGoals } from '@/src/server/pilot/goalProjection';
import { jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // A guardian reads their own child's goals and reported progress (lane
    // N8-05); assertActorCanAccessAthlete below is what makes it their child.
    requireRole(principal, ['organization_admin', 'coach', 'athlete', 'parent']);

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
    // select * carries own_words and why_it_matters. Anyone not named as a
    // full reader (a guardian today) is sent the family projection instead:
    // SMART goals only (filtered in SQL, so the limit counts them), from named
    // fields.
    if (!readsFullGoals(principal.role)) {
      const goals = await getGoalsByAthlete(principal.organizationId, athleteId, { limit, smartOnly: true });
      return NextResponse.json({ items: toFamilySmartGoals(goals) });
    }
    const goals = await getGoalsByAthlete(principal.organizationId, athleteId, { limit });
    return NextResponse.json({ items: goals });
  } catch (error) {
    return jsonError(error);
  }
}
