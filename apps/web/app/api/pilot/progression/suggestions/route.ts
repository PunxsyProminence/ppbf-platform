import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { coachAuthorizedRoster, organizationActionableRoster } from '@/src/server/pilot/coachAthleteRoster';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { getGapSuggestions } from '@/src/server/pilot/progressionSuggestions';

export const runtime = 'nodejs';

// Deterministic gap suggestions for the coach's board (owner decision
// 2026-08-15). Staff-only, and deliberately MORE restricted than the gaps
// themselves: an athlete or parent may read confirmed gaps, but a suggestion
// is a machine's unconfirmed observation and reaches nobody but the coach who
// must confirm or dismiss it. A coach is bounded by the central access
// contract, athleteIdsForCoach (coach_id of record UNION active coverage);
// getAthletesForCoach supplies display names for exactly that subset.
// Nothing here writes; confirmation happens through the ordinary POST
// /api/pilot/progression/gaps by the coach's own hand.

// The pairing this route used to hold inline -- "my athletes" decides
// membership, the whole-org roster read supplies display names -- lives in
// coachAuthorizedRoster. Since issue #1480 this queue is deliberately the
// coach's own athletes ("my athletes" lists keep working, OD-2026-10-11-007),
// while the athlete pickers offer the whole gym.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin']);

    const roster =
      principal.role === 'coach'
        ? await coachAuthorizedRoster(principal.organizationId, principal.accountId)
        : isOrganizationAdminRole(principal.role) || principal.role === 'admin'
          // Live athletes only: a deleted athlete's records are marked deleted
          // with them (scope B), and the coach arm has always excluded them.
          ? await organizationActionableRoster(principal.organizationId)
          : [];

    const names = new Map(roster.map((athlete) => [athlete.athlete_id, athlete.full_name]));
    const suggestions = await getGapSuggestions(
      principal.organizationId,
      roster.map((athlete) => athlete.athlete_id),
    );

    return NextResponse.json({
      items: suggestions.map((suggestion) => ({
        ...suggestion,
        full_name: names.get(suggestion.athlete_id) ?? 'Unknown',
      })),
    });
  } catch (error) {
    return jsonError(error);
  }
}
