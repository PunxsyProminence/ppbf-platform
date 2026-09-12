import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { COACHING_CONTENT_READER_ROLES } from '@/src/server/pilot/coachingContentAccess';
import { getDrillWithDetail, listDrillLibrary } from '@/src/server/pilot/drillLibraryV3';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Read-only browse over pilot.drill_library. GET without drill_id lists
// (filterable by discipline/category/difficulty/skill_id/related_skill_id/
// family_id); GET with drill_id returns one drill's detail, which
// getDrillWithDetail already assembles with all three A/B/C scale levels
// TOGETHER -- the coach picks a level at delivery time, this route never picks
// one for them.
//
// skill_id AND related_skill_id ARE NOT THE SAME QUESTION, and the older one
// did not change meaning when the newer one arrived. skill_id still matches the
// PRIMARY owner alone; related_skill_id matches the primary owner or any
// secondary skill relationship. Widening skill_id in place would have been the
// smaller diff and the wrong one: every existing caller asking who owns a drill
// would have started receiving drills it does not own, without being edited.
//
// family_id IS A THIRD QUESTION AT A DIFFERENT LEVEL, and it arrived the same
// way for the same reason. It takes a promoted family -- SKILL-01..SKILL-12 --
// not a skill code, and the family is expanded to its member codes before any
// comparison reaches a skill column. Both existing parameters keep their exact
// meaning. A family with no approved crosswalk is refused with a 400 rather
// than answered with an empty list, because an empty list would read as "this
// family has no drills" and that is not what happened.
//
// WHO MAY BROWSE was an open question this route used to answer alone, with
// "any authenticated role can browse the library; it carries no athlete data".
// The second half of that is still true and is why the answer is as wide as it
// is. The first half is now decided centrally, because the sibling
// /api/pilot/drills serves the same class of content and disagreed:
// coachingContentAccess.ts holds the one policy, and the board is excluded
// from it. Isolation is unchanged either way -- the reads below take the
// principal's organization and accept no other.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, [...COACHING_CONTENT_READER_ROLES]);

    const { searchParams } = new URL(request.url);
    const drillId = searchParams.get('drill_id');

    if (drillId) {
      const detail = await getDrillWithDetail(principal.organizationId, drillId);
      if (!detail) {
        return NextResponse.json({ error: 'DRILL_NOT_FOUND' }, { status: 404 });
      }
      return NextResponse.json({ drill: detail });
    }

    const drills = await listDrillLibrary(principal.organizationId, {
      discipline: searchParams.get('discipline') ?? undefined,
      category: searchParams.get('category') ?? undefined,
      difficulty: searchParams.get('difficulty') ?? undefined,
      skillId: searchParams.get('skill_id') ?? undefined,
      relatedSkillId: searchParams.get('related_skill_id') ?? undefined,
      familyId: searchParams.get('family_id') ?? undefined,
    });
    return NextResponse.json({ drills });
  } catch (error) {
    return jsonError(error);
  }
}
