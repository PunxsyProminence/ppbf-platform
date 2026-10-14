// GET /api/pilot/coach/family-message-replies?athlete_id= -- what the family
// wrote back under the gym's parent messages to one athlete (#1542, FC-03).
//
// Staff only, the same people and the same athlete gate as
// /api/pilot/coach/family-notes: coach, organization admin and admin, and
// assertActorCanAccessAthlete -- every athlete of the caller's own gym
// (OD-2026-10-11-007) and none of another's (Q-B A). Each reply carries the
// guardian's name from the parent record (Q-D A).
import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { listRepliesForStaff } from '@/src/server/pilot/familyMessageReplies';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const athleteId = new URL(request.url).searchParams.get('athlete_id')?.trim() ?? '';
    if (!athleteId) {
      throw new Error('Missing athlete_id');
    }
    await assertActorCanAccessAthlete(principal, athleteId);

    const items = await listRepliesForStaff(principal.organizationId, athleteId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
