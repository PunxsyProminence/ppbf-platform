import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { getAthletePassbook } from '@/src/server/pilot/passbook';
import { hiddenNotFound, jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'admin', 'coach', 'athlete', 'parent']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim() || '';
    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    await assertActorCanAccessAthlete(principal, athleteId);
    // assertActorCanAccessAthlete answers WHETHER this actor may open the
    // book; principal.role is what lets getAthletePassbook decide which
    // pilot.coach_observations rows belong in it. That table is shared with
    // guardian-authored barrier reports and staff conduct notes, and this
    // gate admits the athlete themselves plus every linked guardian, so the
    // reader's role has to travel with the request.
    const passbook = await getAthletePassbook(principal.organizationId, athleteId, principal.role);
    return passbook ? NextResponse.json({ passbook }) : hiddenNotFound();
  } catch (error) {
    return jsonError(error);
  }
}
