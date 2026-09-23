import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
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
// WHO MAY READ (owner decision 2026-09-22, "Coaches with access"): any coach
// who can already see this athlete in the app -- the coach of record, or a
// covering coach holding an active coverage grant -- plus organization
// admins. That is assertActorCanAccessAthlete's existing rule, reused as it
// stands; no new permission model is introduced here. It refuses a cross-
// organization id on every path.
//
// SOFT-DELETED ATHLETES: THE SHARED HELPER OWNS THIS, AND REFUSES THEM ON
// EVERY PATH. The coach-of-record and org-admin lookups require a live
// athlete row, and so does the coverage lookup: assertCoachAssignedToAthlete
// joins the grant to pilot.athletes and admits only a live athlete in the
// same organization. That last one matters here in particular, because
// deleting an athlete does not end the coverage grants on them -- a covering
// coach can still hold a grant that has not lapsed on an athlete who is gone.
// The rule lives in the helper because the helper is the chokepoint every
// athlete-scoped route calls, so this route does not repeat it; a second,
// route-local copy is a copy the next change to the helper would not know
// to keep in step. A deleted athlete gets the same Forbidden as any other
// refusal.
//
// TWO GATES, IN ORDER. The role list says a staff member may read check-ins;
// it does not say WHOSE. athlete_id is caller-supplied, so the relationship
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
    await assertActorCanAccessAthlete(principal, athleteId);

    // { today: null } is a successful answer -- "checked, nothing recorded
    // today" -- not a missing resource. The coach screen relies on that to
    // keep "no check-in" and "could not read" apart.
    const today = await getTodayCheckIn(principal.organizationId, athleteId);
    return NextResponse.json({ today });
  } catch (error) {
    return jsonError(error);
  }
}
