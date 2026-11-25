// GET /api/pilot/coach/family-threads/unread -- per athlete, how many guardian
// messages this staff member has not seen (W4 item 4, Q4.5 A): the child's
// coach and active covering coaches (athleteIdsForCoach), organization admins
// and admins across the gym, as /api/pilot/escalations scopes. Ids and counts
// only; the decision loop names the athletes from its own roster.
import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { countUnseenFamilyThreadPostsForStaff } from '@/src/server/pilot/familyThreads';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const items = await countUnseenFamilyThreadPostsForStaff({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      role: principal.role,
    });
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}
