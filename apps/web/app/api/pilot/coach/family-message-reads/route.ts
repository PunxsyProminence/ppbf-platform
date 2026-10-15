// GET /api/pilot/coach/family-message-reads?athlete_id= -- which of the gym's
// parent messages to one athlete the family has opened, and when it was first
// opened (#1542, FC-05).
//
// Staff only, the same people and the same athlete gate as
// /api/pilot/coach/family-notes: coach, organization admin and admin, and
// assertActorCanAccessAthlete -- every athlete of the caller's own gym and none
// of another's. Never which guardian opened it, or how many (FC-04 Q-C).
import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { listFamilyReadStateForStaff } from '@/src/server/pilot/familyMessageReads';
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

    const items = await listFamilyReadStateForStaff(principal.organizationId, athleteId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}
