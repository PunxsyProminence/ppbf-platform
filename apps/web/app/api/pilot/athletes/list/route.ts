import { NextResponse, type NextRequest } from 'next/server';

import { getAthleteById, getAthletesByOrganization } from '@/src/server/pilot/entities';
import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { query } from '@/src/server/pilot/db';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete', 'parent', 'admin']);

    if (principal.role === 'athlete') {
      if (!principal.athleteId) {
        return NextResponse.json({ items: [] });
      }

      const athlete = await getAthleteById(principal.organizationId, principal.athleteId);
      return NextResponse.json({ items: athlete ? [athlete] : [] });
    }

    if (principal.role === 'parent') {
      const linkedAthletes = await query(
        `select a.*
         from pilot.athletes a
         join pilot.guardian_links gl on gl.organization_id = a.organization_id and gl.athlete_id = a.athlete_id
         join pilot.parents p on p.organization_id = gl.organization_id and p.parent_id = gl.parent_id
         where a.organization_id = $1 and p.account_id = $2
         order by a.created_at desc`,
        [principal.organizationId, principal.accountId],
      );

      return NextResponse.json({ items: linkedAthletes });
    }

    if (!isOrganizationAdminRole(principal.role) && principal.role !== 'coach') {
      return NextResponse.json({ items: [] });
    }

    const athletes = await getAthletesByOrganization(principal.organizationId);
    return NextResponse.json({ items: athletes });
  } catch (error) {
    return jsonError(error);
  }
}
