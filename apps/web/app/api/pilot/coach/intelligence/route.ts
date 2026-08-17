import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { getAthletesByOrganization, getAthletesForCoach } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getCoachIntelligence } from '@/src/server/pilot/coachIntelligence';

export const runtime = 'nodejs';

// Coach Intelligence v1 (register module 111, owner-approved definition
// 2026-08-16). Same audience derivation as performance analytics and the
// readiness board: a coach reads their OWN roster, an admin reads the
// organization's. Read-only -- this route surfaces; the coach decides.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const isCoach = principal.role === 'coach';
    const athletes = isCoach
      ? await getAthletesForCoach(principal.organizationId, principal.accountId)
      : isOrganizationAdminRole(principal.role)
        ? await getAthletesByOrganization(principal.organizationId)
        : [];

    // athlete_voice escalations are admin-surface only -- see
    // /api/pilot/escalations/route.ts's identical rule.
    const digest = await getCoachIntelligence(
      principal.organizationId,
      athletes.map((athlete) => athlete.athlete_id),
      { excludeAthleteVoice: isCoach },
    );

    return NextResponse.json(digest);
  } catch (error) {
    return jsonError(error);
  }
}
