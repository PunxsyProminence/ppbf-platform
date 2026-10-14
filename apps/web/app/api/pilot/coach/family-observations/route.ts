// GET /api/pilot/coach/family-observations?athlete_id= -- what the family
// recorded at home about one athlete (F-073; #1542's track).
//
// Staff only, the same people and the same athlete gate as
// /api/pilot/coach/family-notes: coach, organization admin and admin, and
// assertActorCanAccessAthlete -- every athlete of the caller's own gym
// (OD-2026-10-11-007) and none of another's. No account id and no name is
// returned (familyObservations.ts); the screen says "a guardian".
import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { listFamilyObservationsForStaff } from '@/src/server/pilot/familyObservations';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const athleteId = new URL(request.url).searchParams.get('athlete_id')?.trim() ?? '';
    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }
    await assertActorCanAccessAthlete(principal, athleteId);

    const items = await listFamilyObservationsForStaff(principal.organizationId, athleteId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
