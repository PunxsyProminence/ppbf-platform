import { NextResponse, type NextRequest } from 'next/server';

import { athleteIdsForCoach, isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { listAthleteIdsCheckedInToday } from '@/src/server/pilot/athleteCheckIns';
import { organizationActionableRoster } from '@/src/server/pilot/coachAthleteRoster';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getReadinessBoard } from '@/src/server/pilot/readinessBoard';

export const runtime = 'nodejs';

// The coach floor's readiness feed (register module 169). Same audience
// derivation as the performance-analytics route: a coach reads the athletes
// the central access contract grants them (athleteIdsForCoach: coach_id of
// record UNION active, unexpired coverage), an admin reads the
// organization's. Athletes without a fresh check-in are absent from the
// response -- the client renders them UNKNOWN, and unknown is never clear.
//
// checked_in_today (F-040): the athletes, of the same audience, with their own
// check-in for the gym's today (pilot.athlete_check_ins). The board's `items`
// come from pilot.readiness, which holds staff-entered intake scores, so an
// athlete's own check-in never reached the floor's "Readings" count. Ids only:
// a self-report carries no band here, and nothing is derived from its answers.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const athleteIds = principal.role === 'coach'
      ? await athleteIdsForCoach(principal.organizationId, principal.accountId)
      : isOrganizationAdminRole(principal.role)
        // Live athletes only: a deleted athlete's records are marked deleted
        // with them (scope B), and the coach arm has always excluded them.
        ? (await organizationActionableRoster(principal.organizationId)).map((athlete) => athlete.athlete_id)
        : [];

    const [items, checkedInToday] = await Promise.all([
      getReadinessBoard(principal.organizationId, athleteIds),
      listAthleteIdsCheckedInToday(principal.organizationId, athleteIds),
    ]);

    return NextResponse.json({ items, checked_in_today: checkedInToday });
  } catch (error) {
    return jsonError(error);
  }
}
