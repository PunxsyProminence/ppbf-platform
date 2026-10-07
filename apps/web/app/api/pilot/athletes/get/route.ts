import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { getAthleteById } from '@/src/server/pilot/entities';
import { isFamilyRecordCaller, toFamilyAthlete } from '@/src/server/pilot/familyRecordView';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete']);

    const body = (await request.json()) as { athlete_id?: string };
    const athleteId = body.athlete_id?.trim() || '';
    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }

    await assertActorCanAccessAthlete(principal, athleteId);
    const athlete = await getAthleteById(principal.organizationId, athleteId);
    if (!athlete) {
      return NextResponse.json({ found: false });
    }

    // An athlete reading their own record gets the family shape: named
    // fields, coach_name in place of coach_id (OD-2026-10-06-025 ruling 2).
    // Staff keep the row.
    if (isFamilyRecordCaller(principal.role)) {
      return NextResponse.json({ found: true, athlete: await toFamilyAthlete(principal.organizationId, athlete) });
    }

    return NextResponse.json({ found: true, athlete });
  } catch (error) {
    return jsonError(error);
  }
}
