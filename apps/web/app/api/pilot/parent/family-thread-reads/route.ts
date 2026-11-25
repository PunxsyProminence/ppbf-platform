// POST /api/pilot/parent/family-thread-reads { post_id } -- the guardian who
// opened a thread records that they have seen a staff reply in it (W4 item 4).
//
// The screen sends this when at least half of the reply is on screen (the
// FC-05 rule the Messages tab already uses); loading the tab is not a read.
// Only a staff post, in a thread this guardian opened, about a child linked to
// them on this request; anything else is the same 404. The first time stays.
import { NextResponse, type NextRequest } from 'next/server';

import { recordFamilyThreadReadByGuardian } from '@/src/server/pilot/familyThreads';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const body = (await request.json().catch(() => null)) as { post_id?: unknown } | null;
    const postId = typeof body?.post_id === 'string' ? body.post_id.trim() : '';
    if (!postId) {
      throw new Error('Missing post_id');
    }

    const item = await recordFamilyThreadReadByGuardian({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      postId,
    });
    return NextResponse.json({ ok: true, item });
  } catch (error) {
    return jsonError(error);
  }
}
