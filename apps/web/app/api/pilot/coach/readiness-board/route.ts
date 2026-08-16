import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { getAthletesByOrganization, getAthletesForCoach } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getReadinessBoard } from '@/src/server/pilot/readinessBoard';

export const runtime = 'nodejs';

// The coach floor's readiness feed (register module 169). Same audience
// derivation as the performance-analytics route: a coach reads their own
// roster through getAthletesForCoach, an admin reads the organization's.
// Athletes without a fresh check-in are absent from the response -- the
// client renders them UNKNOWN, and unknown is never clear.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const athletes = principal.role === 'coach'
      ? await getAthletesForCoach(principal.organizationId, principal.accountId)
      : isOrganizationAdminRole(principal.role)
        ? await getAthletesByOrganization(principal.organizationId)
        : [];

    const items = await getReadinessBoard(
      principal.organizationId,
      athletes.map((athlete) => athlete.athlete_id),
    );

    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
