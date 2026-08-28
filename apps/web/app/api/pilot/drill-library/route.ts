import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { COACHING_CONTENT_READER_ROLES } from '@/src/server/pilot/coachingContentAccess';
import { getDrillWithDetail, listDrillLibrary } from '@/src/server/pilot/drillLibraryV3';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Read-only browse over pilot.drill_library. GET without drill_id lists
// (filterable by discipline/category/difficulty/skill_id); GET with
// drill_id returns one drill's detail, which getDrillWithDetail already
// assembles with all three A/B/C scale levels TOGETHER -- the coach
// picks a level at delivery time, this route never picks one for them.
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
    });
    return NextResponse.json({ drills });
  } catch (error) {
    return jsonError(error);
  }
}
