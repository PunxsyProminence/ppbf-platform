// /api/pilot/parent/message-replies -- a guardian answers a parent message
// (#1542, FC-03).
//
// GET: this guardian's own replies, on messages about the children linked to
// them now. A co-guardian's replies are not here (Jason: with two guardians,
// each sees only their own replies).
// POST { note_id, reply_text }: answer one parent message. The note must be a
// parent message in this gym about a child this guardian is linked to on this
// request (familyMessageReplies.createFamilyMessageReply); anything else is the
// same 404. Replies only: a guardian cannot start a message (Q-A A).
//
// Nothing is sent from here -- no email, no push. Staff read replies under the
// note on /coach/decision-loop (GET /api/pilot/coach/family-message-replies).
import { NextResponse, type NextRequest } from 'next/server';

import { listOwnReplies, createFamilyMessageReply } from '@/src/server/pilot/familyMessageReplies';
import { guardianAthleteIds } from '@/src/server/pilot/guardianAccess';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const athleteIds = await guardianAthleteIds(principal.organizationId, principal.accountId);
    const items = await listOwnReplies(principal.organizationId, principal.accountId, athleteIds);
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const body = (await request.json().catch(() => null)) as
      { note_id?: unknown; reply_text?: unknown } | null;
    const noteId = typeof body?.note_id === 'string' ? body.note_id.trim() : '';
    if (!noteId) {
      throw new Error('Missing note_id');
    }
    if (typeof body?.reply_text !== 'string') {
      throw new Error('Missing reply_text');
    }

    const item = await createFamilyMessageReply({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      noteId,
      replyText: body.reply_text,
    });
    return NextResponse.json({ ok: true, item });
  } catch (error) {
    return jsonError(error);
  }
}
