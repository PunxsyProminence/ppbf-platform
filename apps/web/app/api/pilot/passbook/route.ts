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
    const passbook = await getAthletePassbook(principal.organizationId, athleteId);
    return passbook ? NextResponse.json({ passbook }) : hiddenNotFound();
  } catch (error) {
    return jsonError(error);
  }
}
