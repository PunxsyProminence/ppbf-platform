import { NextResponse, type NextRequest } from 'next/server';

import { isOrganizationAdminRole, requireRole } from '@/src/server/pilot/access';
import { organizationActionableRoster } from '@/src/server/pilot/coachAthleteRoster';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The athletes this staff member may act ON, for a picker.
 *
 * WHY THIS IS NOT /api/pilot/athletes/list. That route answers a coach with
 * getAthletesForCoach, a DISPLAY projection of the gym's live athletes (since
 * #1480 PR C with every field); it is not an access contract and says so. While a coach's reach was "my athletes", a
 * picker built on it offered athletes whose writes the server refused. The
 * picker's membership is decided here, from the same rule the write path
 * applies, so the two cannot drift apart again.
 *
 * A COACH'S REACH IS THE WHOLE GYM (OD-2026-10-11-007, issue #1480):
 * assertActorCanAccessAthlete admits a coach to every live athlete of their
 * own organization, exactly as it admits an organization admin. So both roles
 * read the same set here -- the organization's actionable roster -- and the
 * picker offers what the write path accepts. This was "my athletes" (coach of
 * record UNION active coverage) until the gate widened; left that way it
 * hid from a coach the athletes every write route now lets them act on.
 * "My athletes" digests (intelligence, readiness board) keep their own scope.
 *
 * SOFT-DELETED ATHLETES ARE EXCLUDED, because the gate does:
 * organizationActionableRoster rather than getAthletesByOrganization.
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

    const roster = principal.role === 'coach' || isOrganizationAdminRole(principal.role)
      /* NOT getAthletesByOrganization: that read carries no deletion
         predicate, and assertAthleteBelongsToOrganization -- the gate the
         writes then pass through -- refuses a soft-deleted athlete. A
         picker built on the unfiltered read offers archived children whose
         every write is then refused. */
      ? await organizationActionableRoster(principal.organizationId)
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
