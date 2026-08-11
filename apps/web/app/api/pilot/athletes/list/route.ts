import { NextResponse, type NextRequest } from 'next/server';

import { getAthleteById, getAthletesByOrganization, getAthletesForCoach } from '@/src/server/pilot/entities';
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

    // Coaches and organization admins both read the whole roster, and they do
    // NOT read the same row. An admin administers the organization's records;
    // a coach coaches particular athletes. So the coach's read goes through
    // getAthletesForCoach, which keeps every athlete's name and gym status --
    // a coach plans a floor and picks up cover across the whole gym -- while
    // returning dob and emergency_contact only for athletes this coach is the
    // coach of record for or holds an active coverage grant on.
    //
    // Checked before the admin branch, and with an exact role comparison: a
    // coach is never an organization admin, and isOrganizationAdminRole's
    // legacy 'admin' aliasing has nothing to say about the coach role.
    if (principal.role === 'coach') {
      const roster = await getAthletesForCoach(principal.organizationId, principal.accountId);
      return NextResponse.json({ items: roster });
    }

    if (!isOrganizationAdminRole(principal.role)) {
      return NextResponse.json({ items: [] });
    }

    const athletes = await getAthletesByOrganization(principal.organizationId);
    return NextResponse.json({ items: athletes });
  } catch (error) {
    return jsonError(error);
  }
}
