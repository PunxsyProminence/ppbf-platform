import { NextResponse, type NextRequest } from 'next/server';

import { getDrillWithDetail, listDrillLibrary } from '@/src/server/pilot/drillLibraryV3';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

// Read-only browse over pilot.drill_library. GET without drill_id lists
// (filterable by discipline/category/difficulty/skill_id); GET with
// drill_id returns one drill's detail, which getDrillWithDetail already
// assembles with all three A/B/C scale levels TOGETHER -- the coach
// picks a level at delivery time, this route never picks one for them.
// Any authenticated role can browse the library; it carries no athlete
// data.
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);

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
