import { NextResponse, type NextRequest } from 'next/server';

import { athleteIdsForCoach, isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { getAthletesByOrganization, getAthletesForCoach } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import {
  clampWindowDays,
  getPerformanceRollup,
} from '@/src/server/pilot/performanceAnalytics';

export const runtime = 'nodejs';

// Read-only performance analytics rollup (operations-radar capability
// "Performance Analytics").
//
// Scope mirrors attendance-summary/route.ts's deliberate narrowness:
//   * organization_admin/admin read the whole organization's roster.
//   * coach is bounded by the central access contract, athleteIdsForCoach --
//     coach_id of record UNION active, unexpired coverage, the same union
//     /api/pilot/escalations applies. getAthletesForCoach supplies display
//     names for exactly that subset; its own org-wide list is a redacted
//     display projection, never an access boundary.
//   * athlete, parent, and every other role: forbidden. This is a staff
//     reporting surface; athlete- and parent-facing progression views exist
//     separately and carry their own scoping.

// The whole-org roster read supplies display names; the access contract
// decides which athletes are computed over at all.
async function coachScopedRoster(organizationId: string, coachAccountId: string) {
  const accessible = new Set(await athleteIdsForCoach(organizationId, coachAccountId));
  const roster = await getAthletesForCoach(organizationId, coachAccountId);
  return roster.filter((athlete) => accessible.has(athlete.athlete_id));
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin']);

    const windowDays = clampWindowDays(request.nextUrl.searchParams.get('window_days'));

    const roster =
      principal.role === 'coach'
        ? await coachScopedRoster(principal.organizationId, principal.accountId)
        : isOrganizationAdminRole(principal.role) || principal.role === 'admin'
          ? await getAthletesByOrganization(principal.organizationId)
          : [];

    const names = new Map(roster.map((athlete) => [athlete.athlete_id, athlete.full_name]));
    const rollup = await getPerformanceRollup(
      principal.organizationId,
      roster.map((athlete) => athlete.athlete_id),
      windowDays,
    );

    return NextResponse.json({
      window_days: windowDays,
      items: rollup.map((row) => ({ ...row, full_name: names.get(row.athlete_id) ?? 'Unknown' })),
    });
  } catch (error) {
    return jsonError(error);
  }
}
