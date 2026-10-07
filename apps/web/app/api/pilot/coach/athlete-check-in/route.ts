import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { getTodayCheckIn } from '@/src/server/pilot/athleteCheckIns';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { readStaffHoldWarning } from '@/src/server/pilot/trainingHolds';

export const runtime = 'nodejs';

// A-FIN-03: staff read of ONE athlete's wellness check-in for today.
//
// The athlete's own route (/api/pilot/athlete/check-in) is SELF ONLY and
// stays that way -- it has no athlete_id parameter and refuses every other
// role, and its test asserts exactly that. Its header named "coach/admin views
// of arrivals" as a later, separate read surface; this is that surface, and it
// is separate precisely so the self-only route never grows a parameter that
// aims it at somebody else.
//
// WHO MAY READ (OD-2026-10-05-024 ruling 2, Jason 2026-10-05, superseding
// A-FIN-03R1's "any coach or admin" for this read): the athlete's coach of
// record, a coach holding a live coverage grant, or an organization admin in
// the athlete's own organization -- assertActorCanAccessAthlete, the same
// gate every other athlete-scoped capability uses.
//
// SOFT-DELETED ATHLETES: the shared gate OWNS THIS AND REFUSES THEM. Every
// arm requires `deleted_at is null` (src/server/pilot/access.ts), so a
// deleted athlete falls through to the same Forbidden as an athlete in
// another gym -- even though the check-in row of a deleted athlete is still
// stored. The rule lives in the helper rather than being repeated here.
//
// REFUSALS STAY INDISTINGUISHABLE per caller. For a coach, "not mine",
// cross-organization, soft-deleted and "no such athlete_id anywhere" all
// throw the one assignment message; for an admin, the one organization
// message. A refusal tells the caller nothing about whether the id names a
// real child.
//
// TWO GATES, IN ORDER. The role list says a staff member may read check-ins;
// it does not say WHOSE. athlete_id is caller-supplied, so the athlete gate
// decides that second question -- including whether the athlete is still
// live -- before any check-in row is read.
// Athlete, parent, platform_owner, board and every other role stop at the
// first gate -- an athlete reads their own through the self route, and no
// parent wellness surface exists.
//
// READ ONLY, AND NOTHING DERIVED. GET is the only export. The row goes out as
// the module's reader returns it: no GREEN/YELLOW/RED band, no average, no
// score, no clearance -- src/shared/wellnessScales.ts is explicit that these
// self-reports are not a readiness score -- and a skipped question stays null
// rather than acquiring a default on its way to the coach.
//
// The organization is the principal's own and is never taken from the
// request: there is no organization_id parameter here, by design.

const ATHLETE_CHECK_IN_READ_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...ATHLETE_CHECK_IN_READ_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');
    await assertActorCanAccessAthlete(principal, athleteId);

    // { today: null } is a successful answer -- "checked, nothing recorded
    // today" -- not a missing resource. The coach screen relies on that to
    // keep "no check-in" and "could not read" apart.
    const today = await getTodayCheckIn(principal.organizationId, athleteId);

    // OD-2026-10-06-024 ruling 1 ("Warn only, both places"): an active
    // training hold changes nothing about this read -- the check-in goes out as
    // it always did -- but the staff member reading it is told the athlete is
    // held. Only the gate above's three roles reach here, and the read never
    // throws. The key is absent when the athlete is not held.
    const holdWarning = await readStaffHoldWarning(principal.role, principal.organizationId, athleteId);
    return NextResponse.json(holdWarning ? { today, hold_warning: holdWarning } : { today });
  } catch (error) {
    return jsonError(error);
  }
}
