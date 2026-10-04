import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { athleteIsYouth, summarizeBodyMass } from '@/src/server/pilot/athleteBodyMass';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// A parent's read of their own child's latest weigh-in and seven-day change
// (elite-boxing item 5; Jason 2026-10-04: a youth's weight is visible to the
// child's coach AND parents). Youth only -- see below. PARENT ONLY, and only for a child the parent is
// linked to: assertActorCanAccessAthlete's parent arm checks the guardian link
// in the parent's own organization, and refuses everything else with the same
// 403 whether or not the athlete exists. Read only; the organization comes
// from the session, never the request.

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id')?.trim();
    if (!athleteId) throw new ValidationError('Missing athlete_id.');
    await assertActorCanAccessAthlete(principal, athleteId);
    // YOUTH ONLY. Jason's ruling names parents for a youth's weight; an adult's
    // follows the check-in, which has no parent surface. A guardian link made
    // when the athlete was 16 outlives their 18th birthday, so age is checked
    // here, not assumed from the link. Also reads the athlete row with
    // deleted_at is null. An adult, like no weigh-in, is body_mass: null.
    if ((await athleteIsYouth(principal.organizationId, athleteId)) !== true) {
      return NextResponse.json({ body_mass: null });
    }

    const summary = await summarizeBodyMass(principal.organizationId, athleteId);
    return NextResponse.json({ body_mass: summary.latest ? summary : null });
  } catch (error) {
    return jsonError(error);
  }
}
