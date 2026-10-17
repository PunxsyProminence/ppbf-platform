// /api/pilot/parent/message-reads -- whether this guardian opened a coach
// message. Parent only; gym and account from the session.
//
// GET: this guardian's own opens, on messages about the children linked to
// them now (#1542, FC-08; familyMessageReads.listOwnMessageReads). A
// co-guardian's opens are not here. The hub marks the rest "New".
// POST { note_id }: the guardian opened this coach message on the Messages tab
// (FC-05). The note must be a parent message in this gym about a child linked
// to them on this request (familyMessageReads.recordFamilyMessageRead);
// anything else is the same 404. A second open keeps the first time. Nothing
// is sent from here.
import { NextResponse, type NextRequest } from 'next/server';

import { listOwnMessageReads, recordFamilyMessageRead } from '@/src/server/pilot/familyMessageReads';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const items = await listOwnMessageReads(principal.organizationId, principal.accountId);
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const body = (await request.json().catch(() => null)) as { note_id?: unknown } | null;
    const noteId = typeof body?.note_id === 'string' ? body.note_id.trim() : '';
    if (!noteId) {
      throw new Error('Missing note_id');
    }

    const read = await recordFamilyMessageRead({
      organizationId: principal.organizationId,
      accountId: principal.accountId,
      noteId,
    });
    return NextResponse.json({ ok: true, read });
  } catch (error) {
    return jsonError(error);
  }
}
