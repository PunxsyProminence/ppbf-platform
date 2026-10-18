// /api/pilot/coach/family-reply-reads -- which guardian replies the signed-in
// staff member has already seen (#1542's track, FC-09b).
//
// GET ?athlete_id= -- this staff member's own seen replies on that athlete's
// parent messages; never another staff member's.
// POST { reply_id } -- at least half of that reply was on screen in the coach
// panel (FC-05 Q-1 A, applied to replies); a second look keeps the first time.
//
// Staff only, the same people and the same athlete gate as
// /api/pilot/coach/family-message-replies: coach, organization admin and
// admin, and assertActorCanAccessAthlete -- every athlete of the caller's own
// gym (OD-2026-10-11-007) and none of another's. For POST the gate runs on the
// reply's athlete (familyReplyReads.recordFamilyReplyRead). The gym and the
// reader come from the session, never the request.
import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { listOwnReplyReads, recordFamilyReplyRead } from '@/src/server/pilot/familyReplyReads';
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

    const items = await listOwnReplyReads(principal.organizationId, principal.accountId, athleteId);
    return NextResponse.json({ items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const body = (await request.json().catch(() => null)) as { reply_id?: unknown } | null;
    const replyId = typeof body?.reply_id === 'string' ? body.reply_id.trim() : '';
    if (!replyId) {
      throw new Error('Missing reply_id');
    }

    const read = await recordFamilyReplyRead(
      { organizationId: principal.organizationId, accountId: principal.accountId, role: principal.role },
      replyId,
    );
    return NextResponse.json({ ok: true, read });
  } catch (error) {
    return jsonError(error);
  }
}
