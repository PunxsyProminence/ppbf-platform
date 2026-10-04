import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { readMentalSkills } from '@/src/server/pilot/athleteMentalSkills';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Athlete mental skills, staff read (map item 21). READ ONLY: staff never
// write an athlete's self-talk or imagery log. Which athlete a coach may read
// is decided in athleteMentalSkills.ts by assertActorCanAccessAthlete (coach of
// record or covering coach; org admin for their own gym), not by this route.

const STAFF_READ_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...STAFF_READ_ROLES]);
    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');
    return NextResponse.json(await readMentalSkills(principal, athleteId));
  } catch (error) {
    return jsonError(error);
  }
}
