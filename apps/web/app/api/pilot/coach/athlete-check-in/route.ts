import { NextResponse, type NextRequest } from 'next/server';

import { assertAthleteBelongsToOrganization, requireRole } from '@/src/server/pilot/access';
import { getTodayCheckIn } from '@/src/server/pilot/athleteCheckIns';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

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
// WHO MAY READ (A-FIN-03R1, owner decision 2026-09-22: "any coach or admin
// should be able to read it"): any coach or organization admin in the
// athlete's OWN organization. Assignment and coverage are not consulted and
// are not looked up -- the earlier rule here (coach of record, or a covering
// coach holding an active grant) is gone, so a coach who is neither now reads
// the check-in of any live athlete the gym roster already shows them. That
// roster is the whole gym by design, which is why deliberate selection in
// CoachWorkspace, not an assignment, is what decides whose self-report a
// coach ends up looking at.
//
// THIS WIDENING IS THIS ROUTE'S ALONE. assertActorCanAccessAthlete still
// holds the coach-of-record-or-coverage rule and still decides every other
// athlete-scoped capability (sessions, progression, video, intake, ...);
// nothing there was touched. Only the wellness read moved to organization
// membership, and it does so by calling the organization check directly
// rather than by loosening the shared gate underneath every other route.
//
// SOFT-DELETED ATHLETES: assertAthleteBelongsToOrganization OWNS THIS AND
// REFUSES THEM. Its one query requires `deleted_at is null` alongside the
// composite key (src/server/pilot/access.ts), so a deleted athlete matches no
// row and falls through to the same Forbidden as an athlete in another gym --
// even though the check-in row of a deleted athlete is still stored. The rule
// lives in the helper rather than being repeated here: a route-local copy is
// a copy the next change to the helper would not know to keep in step.
//
// REFUSALS STAY INDISTINGUISHABLE. Cross-organization, soft-deleted and "no
// such athlete_id anywhere" all throw the one message the helper throws, and
// jsonError turns any Forbidden into the same 403 body. A refusal therefore
// tells the caller nothing about whether the id names a real child.
//
// TWO GATES, IN ORDER. The role list says a staff member may read check-ins;
// it does not say WHOSE. athlete_id is caller-supplied, so the organization
// gate decides that second question -- including whether the athlete is
// still live -- before any check-in row is read.
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
    await assertAthleteBelongsToOrganization(principal.organizationId, athleteId);

    // { today: null } is a successful answer -- "checked, nothing recorded
    // today" -- not a missing resource. The coach screen relies on that to
    // keep "no check-in" and "could not read" apart.
    const today = await getTodayCheckIn(principal.organizationId, athleteId);
    return NextResponse.json({ today });
  } catch (error) {
    return jsonError(error);
  }
}
