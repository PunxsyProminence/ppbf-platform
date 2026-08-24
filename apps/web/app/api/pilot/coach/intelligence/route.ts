import { NextResponse, type NextRequest } from 'next/server';

import { athleteIdsForCoach, isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { getAthletesByOrganization } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getCoachIntelligence } from '@/src/server/pilot/coachIntelligence';

export const runtime = 'nodejs';

// Coach Intelligence v1 (register module 111, owner-approved definition
// 2026-08-16). An admin reads the organization's athletes; a coach reads
// exactly the athletes the central access contract grants them --
// athleteIdsForCoach: coach_id of record UNION active, unexpired coverage,
// the same union /api/pilot/escalations applies. Read-only -- this route
// surfaces; the coach decides.
//
// The athlete id list built below IS this capability's access boundary. The
// digest takes no athlete_id, no organization_id, and no filter from the
// caller: every one of its seven items is scoped to exactly these ids inside
// getCoachIntelligence, so a coach cannot widen the read by asking. That
// matters most for the two safety registers the digest carries (open
// escalations, open compliance violations): this list is what stands between
// a coach and another coach's athlete's safeguarding record, which is why it
// comes from the access contract and NOT from getAthletesForCoach -- that
// roster read deliberately returns every athlete in the organization (a
// display projection with field redaction) and must never be used as an
// access boundary. Full gate list: getCoachIntelligence's own comments,
// including the athlete_voice exclusion the digest applies unconditionally
// because it is handed ids and an organization but never a role.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const athleteIds = principal.role === 'coach'
      ? await athleteIdsForCoach(principal.organizationId, principal.accountId)
      : isOrganizationAdminRole(principal.role)
        ? (await getAthletesByOrganization(principal.organizationId)).map((athlete) => athlete.athlete_id)
        : [];

    const digest = await getCoachIntelligence(principal.organizationId, athleteIds);

    return NextResponse.json(digest);
  } catch (error) {
    return jsonError(error);
  }
}
