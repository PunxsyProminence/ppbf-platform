import { NextResponse, type NextRequest } from 'next/server';

import {
  getCurrentDisciplineParticipation,
  listDisciplines,
  listGrapplingExposure,
} from '@/src/server/pilot/multidiscipline';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// READ ONLY, deliberately.
//
// multidiscipline.ts also carries write paths -- recordGrapplingExposure,
// recordDisciplineParticipation, recordMixedAgeSession -- and none of them is
// exposed here. Recording that a child had a choke completed on them is a
// safeguarding event, and what a coach is prompted to enter at that moment is
// a decision about the gym's practice, not a shape to infer from the schema.
// That form is left for the owner to specify rather than guessed at.
//
// GET without athlete_id returns the discipline list: which arts the gym runs,
// under which governing body, and what its age policy cites. That is policy,
// readable by any authenticated role.
//
// GET with athlete_id returns one athlete's grappling exposure history and
// current participation level. That is athlete safety data, restricted to
// coach and admin.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

    const { searchParams } = new URL(request.url);
    const athleteId = searchParams.get('athlete_id');

    if (athleteId) {
      requireRole(principal, ['coach', 'admin']);

      const [exposure, participation] = await Promise.all([
        listGrapplingExposure(principal.organizationId, athleteId),
        getCurrentDisciplineParticipation(principal.organizationId, athleteId),
      ]);
      return NextResponse.json({ exposure, participation });
    }

    // activeOnly defaults to true: a retired discipline is one the gym no
    // longer runs, and it should not sit in a browse list beside live ones.
    const disciplines = await listDisciplines(principal.organizationId, {
      activeOnly: searchParams.get('include_inactive') === 'true' ? undefined : true,
    });
    return NextResponse.json({ disciplines });
  } catch (error) {
    return jsonError(error);
  }
}
