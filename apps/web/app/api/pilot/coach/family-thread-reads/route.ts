// POST /api/pilot/coach/family-thread-reads { post_id } -- the signed-in staff
// member has seen a guardian's post in a family thread: at least half of it on
// screen in the coach panel (FC-05 Q-1 A, as FC-09b's replies). A second look
// keeps the first time. "New to me" is each staff member's own (W4 item 4).
//
// Staff only, the same people as /api/pilot/coach/family-threads: coach,
// organization admin and admin. The athlete gate (assertActorCanAccessAthlete)
// runs on the post's athlete (familyThreads.recordFamilyThreadReadByStaff); a
// staff post, a forged id, another gym's post or an athlete the caller cannot
// reach is one 404. The gym and the reader come from the session.
import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { recordFamilyThreadReadByStaff } from '@/src/server/pilot/familyThreads';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const body = (await request.json().catch(() => null)) as { post_id?: unknown } | null;
    const postId = typeof body?.post_id === 'string' ? body.post_id.trim() : '';
    if (!postId) {
      throw new Error('Missing post_id');
    }

    const read = await recordFamilyThreadReadByStaff(
      { organizationId: principal.organizationId, accountId: principal.accountId, role: principal.role },
      postId,
    );
    return NextResponse.json({ ok: true, read });
  } catch (error) {
    return jsonError(error);
  }
}
