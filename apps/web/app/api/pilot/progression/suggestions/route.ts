import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { coachAuthorizedRoster } from '@/src/server/pilot/coachAthleteRoster';
import { getAthletesByOrganization } from '@/src/server/pilot/entities';
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

// The pairing this route used to hold inline -- the access contract decides
// membership, the whole-org roster read supplies display names -- now lives in
// coachAuthorizedRoster so that the sparring log's athlete picker and this
// route cannot drift into two different answers to "which athletes is this
// coach allowed to reach".

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'admin', 'organization_admin']);

    const roster =
      principal.role === 'coach'
        ? await coachAuthorizedRoster(principal.organizationId, principal.accountId)
        : isOrganizationAdminRole(principal.role) || principal.role === 'admin'
          ? await getAthletesByOrganization(principal.organizationId)
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
