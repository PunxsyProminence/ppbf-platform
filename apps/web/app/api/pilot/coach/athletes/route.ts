import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { coachAuthorizedRoster } from '@/src/server/pilot/coachAthleteRoster';
import { getAthletesByOrganization } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The athletes this staff member may act ON, for a picker.
 *
 * WHY THIS IS NOT /api/pilot/athletes/list. That route answers a coach with
 * getAthletesForCoach, which returns EVERY athlete in the organization and
 * merely redacts dob and emergency_contact for the ones the coach is
 * unrelated to. It is a display projection and it says so. Populating a
 * "which athlete am I logging this for" control from it offers a coach
 * athletes whose writes the server will refuse -- a picker full of options
 * that fail, on a safeguarding surface, with the refusal arriving only after
 * the coach has typed the session in.
 *
 * A coach here is bounded by the central access contract
 * (athleteIdsForCoach: coach of record UNION active, unexpired coverage), the
 * same union assertActorCanAccessAthlete applies on every write. An
 * organization admin reads the organization's athletes, matching what
 * assertActorCanAccessAthlete grants that role (assertAthleteBelongsToOrganization)
 * and matching what /api/pilot/coach/intelligence and
 * /api/pilot/coach/readiness-board already do. No role is broadened here.
 *
 * THIS IS A CONVENIENCE, NOT A GATE. Every write route keeps its own
 * assertActorCanAccessAthlete; a client that ignores this list and posts some
 * other athlete id is refused there, exactly as before. Narrowing a picker is
 * how a coach avoids a pointless refusal, never how the refusal is enforced.
 *
 * Name and id only. This route deliberately does not pass through dob,
 * emergency_contact, medical state, or anything else a picker has no use for:
 * a control that needs two fields should not become a second athlete-record
 * read.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const roster = principal.role === 'coach'
      ? await coachAuthorizedRoster(principal.organizationId, principal.accountId)
      : isOrganizationAdminRole(principal.role)
        ? await getAthletesByOrganization(principal.organizationId)
        : [];

    return NextResponse.json({
      ok: true,
      items: roster.map((athlete) => ({
        athlete_id: athlete.athlete_id,
        full_name: athlete.full_name,
      })),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
