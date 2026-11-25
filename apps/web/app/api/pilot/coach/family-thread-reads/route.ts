// POST /api/pilot/coach/family-thread-reads { post_id } -- the signed-in staff
// member has seen a guardian's post in a family thread (half of it on screen,
// FC-05 Q-1 A); the first time stays (W4 item 4). Staff only; the athlete gate
// runs on the post's athlete in familyThreads.recordFamilyThreadReadByStaff.
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
