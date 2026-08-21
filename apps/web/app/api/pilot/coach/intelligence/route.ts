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
//
// The athlete id list built below IS this capability's access boundary. The
// digest takes no athlete_id, no organization_id, and no filter from the
// caller: every one of its seven items is scoped to exactly these ids inside
// getCoachIntelligence, so a coach cannot widen the read by asking. That
// matters more now than it did at v1 -- since the digest gained the two
// safety registers (open escalations, open compliance violations) this list
// is what stands between a coach and another coach's athlete's safeguarding
// record. Full gate list: getCoachIntelligence's own comments, including the
// athlete_voice exclusion the digest applies unconditionally because it is
// handed ids and an organization but never a role. Coverage asymmetry worth
// knowing: this roster is coach_id-of-record only -- it does not union
// pilot.coach_coverage the way /api/pilot/escalations does, so a covering
// coach sees a covered child on the escalation queue but not here.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const athletes = principal.role === 'coach'
      ? await getAthletesForCoach(principal.organizationId, principal.accountId)
      : isOrganizationAdminRole(principal.role)
        ? await getAthletesByOrganization(principal.organizationId)
        : [];

    const digest = await getCoachIntelligence(
      principal.organizationId,
      athletes.map((athlete) => athlete.athlete_id),
    );

    return NextResponse.json(digest);
  } catch (error) {
    return jsonError(error);
  }
}
