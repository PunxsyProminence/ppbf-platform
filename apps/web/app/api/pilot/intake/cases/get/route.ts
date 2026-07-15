import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getIntakeCaseAggregate } from '@/src/server/pilot/intake';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete', 'parent']);

    const body = (await request.json()) as { intake_case_id?: string };
    const intakeCaseId = body.intake_case_id?.trim() || '';
    if (!intakeCaseId) {
      throw new Error('Missing intake_case_id');
    }

    const aggregate = await getIntakeCaseAggregate(principal.organizationId, intakeCaseId);
    if (!aggregate) {
      return NextResponse.json({ found: false });
    }

    const intakeCase = (aggregate.intake_case ?? null) as { primary_athlete_id?: string | null } | null;
    const athleteId = intakeCase?.primary_athlete_id ?? null;
    if (athleteId) {
      await assertActorCanAccessAthlete(principal, athleteId);
    }

    return NextResponse.json({ found: true, aggregate });
  } catch (error) {
    return jsonError(error);
  }
}
