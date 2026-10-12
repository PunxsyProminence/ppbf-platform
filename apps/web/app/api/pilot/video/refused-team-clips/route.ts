// GET /api/pilot/video/refused-team-clips -- how many team clips the content
// screen refused that no administrator has decided yet (#1445 Q2 B, authorized
// by Overwatch on #1508). The top bar's count.
//
// A NUMBER AND NOTHING ELSE. The clips themselves are listed by
// /api/pilot/video/list?scope=all&filter=refused_team, which reads the same
// predicate (refusedTeamClips.ts), so the badge and the review page cannot
// disagree about what was counted.
//
// Organization admins only: the same people the safeguarding review's
// scope=all list admits, and the only role that can approve or block.
import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { countRefusedTeamClips } from '@/src/server/pilot/refusedTeamClips';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // The organization admin roles (access.ts isOrganizationAdminRole).
    requireRole(principal, ['organization_admin', 'admin']);
    const count = await countRefusedTeamClips(principal.organizationId);
    return NextResponse.json({ count });
  } catch (error) {
    return jsonError(error);
  }
}
