import { NextResponse, type NextRequest } from 'next/server';

import { getAthleteById, getAthletesByOrganization, getAthletesForCoach } from '@/src/server/pilot/entities';
import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { query } from '@/src/server/pilot/db';
import { jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';

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

    // `a.deleted_at is null` is the same filter guardianAccess.ts carries on
    // its own join, and it has to be restated here because this branch is on
    // that module's allowlist and keeps its join inline. guardian_links has no
    // deleted_at of its own, so a link to a withdrawn athlete stays true
    // forever and only the join onto pilot.athletes can close it.
    //
    // Without it this route was the one guardian path that still listed a
    // withdrawn child: isGuardianLinkedToAthlete, guardianAthleteIds and
    // assertActorCanAccessAthlete all refuse them, so the child appeared in
    // the picker and then had no data behind them anywhere. It is the list
    // every parent surface builds its child selector from, which is why it
    // was the one worth missing.
    if (principal.role === 'parent') {
      const linkedAthletes = await query(
        `select a.*
         from pilot.athletes a
         join pilot.guardian_links gl on gl.organization_id = a.organization_id and gl.athlete_id = a.athlete_id
         join pilot.parents p on p.organization_id = gl.organization_id and p.parent_id = gl.parent_id
         where a.organization_id = $1 and p.account_id = $2 and a.deleted_at is null
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

    // Unbounded before this: SELECT * with no LIMIT, so an admin roster
    // page load pulled every athlete row in the org regardless of size.
    // limit is optional -- an admin browsing the roster with no params
    // still gets everything, exactly today's behavior -- but a caller that
    // wants a bounded page (or that hits a gym with hundreds of athletes)
    // now has a real way to ask for one.
    const rawLimit = request.nextUrl.searchParams.get('limit');
    const limit = rawLimit === null ? null : parseSafeLimit(rawLimit, 0, 2000);
    if (rawLimit !== null && limit === null) {
      return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 });
    }
    const rawOffset = request.nextUrl.searchParams.get('offset');
    const offset = rawOffset === null ? 0 : Math.max(Number.parseInt(rawOffset, 10) || 0, 0);

    const athletes = await getAthletesByOrganization(
      principal.organizationId,
      limit ? { limit, offset } : undefined,
    );
    return NextResponse.json({ items: athletes });
  } catch (error) {
    return jsonError(error);
  }
}
