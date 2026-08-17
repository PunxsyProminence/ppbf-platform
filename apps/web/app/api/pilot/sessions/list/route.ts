import { NextResponse, type NextRequest } from 'next/server';

import { getSessionsByAthlete } from '@/src/server/pilot/entities';
import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    if (!athleteId) throw new Error('Missing athlete_id');

    // See goals/list/route.ts: one caller, no completeness-dependent
    // consumer, so a real default cap applies rather than opt-in-only.
    const limit = parseSafeLimit(request.nextUrl.searchParams.get('limit'), 200, 500);
    if (limit === null) {
      return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 });
    }

    await assertActorCanAccessAthlete(principal, athleteId);
    const sessions = await getSessionsByAthlete(principal.organizationId, athleteId, { limit });
    return NextResponse.json({ items: sessions });
  } catch (error) {
    return jsonError(error);
  }
}
