import { NextResponse, type NextRequest } from 'next/server';

import { assertAthleteBelongsToOrganization, requireRole } from '@/src/server/pilot/access';
import { bodyMassVisibleTo, summarizeBodyMass } from '@/src/server/pilot/athleteBodyMass';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Staff read of ONE athlete's latest weigh-in and seven-day weight change
// (elite-boxing item 5).
//
// A SIBLING OF coach/athlete-check-in, NOT PART OF IT. That route is pinned to
// organization membership alone (A-FIN-03R1) and its tests hold it there. Body
// mass is narrower for a youth (Jason 2026-10-04: "B everyone, youth
// limited", "Yes, keep org admin"), so it gets its own gate here instead of
// loosening that one:
//   1. role: coach or organization admin;
//   2. the athlete is live in the caller's organization -- otherwise the same
//      403 the check-in route gives;
//   3. bodyMassVisibleTo: an adult's weight goes to any reader past 2; a
//      youth's (or no recorded date of birth) only to a reader
//      assertActorCanAccessAthlete admits -- the assigned or covering coach,
//      or the organization admin.
// A reader who fails 3 gets `body_mass: null`, the same answer as an athlete
// who never entered a weight, so the response does not reveal that a youth's
// weight exists.
//
// The flag inside the summary is a fixed rule (>5% of body mass in 7 days, up
// or down), not a score, and nothing acts on it. Read only; the organization
// is the session's, never the request's.

const BODY_MASS_READ_ROLES = ['coach', 'organization_admin', 'admin'] as const;

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...BODY_MASS_READ_ROLES]);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');
    await assertAthleteBelongsToOrganization(principal.organizationId, athleteId);

    if (!(await bodyMassVisibleTo(principal, principal.organizationId, athleteId))) {
      return NextResponse.json({ body_mass: null });
    }
    const summary = await summarizeBodyMass(principal.organizationId, athleteId);
    return NextResponse.json({ body_mass: summary.latest ? summary : null });
  } catch (error) {
    return jsonError(error);
  }
}
