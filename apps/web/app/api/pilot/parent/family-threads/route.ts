// /api/pilot/parent/family-threads -- a guardian writes to the coach about
// their own child (W4 item 4, scrub FAM-09; OW27-24 A).
//
// GET: the threads this guardian opened, about children linked to them now,
// with the staff replies in them and which replies are new to this guardian.
// A co-guardian's threads are not here (OD-2026-10-12-024).
// POST { athlete_id, text }: open a thread about a child linked to this
// guardian on this request (403 otherwise, as assertActorCanAccessAthlete's
// parent arm says).
// POST { thread_id, text }: write again in a thread this guardian opened
// (Overwatch Q2 A on #2161); anyone else's thread, or an ended link, is 404.
//
// Nothing is sent from here: no email, no push (email is lane W4-1's, Q1.9).
// Staff read and answer through /api/pilot/coach/family-threads and on
// /coach/decision-loop, which the next two PRs of W4 item 4 add.
import { NextResponse, type NextRequest } from 'next/server';

import { listOwnFamilyThreads, startFamilyThread, writeAgainInFamilyThread } from '@/src/server/pilot/familyThreads';
import { ValidationError } from '@/src/server/pilot/errors';
import { jsonError, requirePrincipal, requireRole } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const items = await listOwnFamilyThreads(principal.organizationId, principal.accountId);
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
      { athlete_id?: unknown; thread_id?: unknown; text?: unknown } | null;
    // Exactly one of the two, as text: a stray or mistyped second id is refused, never ignored.
    for (const value of [body?.athlete_id, body?.thread_id]) {
      if (value !== undefined && value !== null && typeof value !== 'string') {
        throw new ValidationError('athlete_id and thread_id are text.');
      }
    }
    const athleteId = typeof body?.athlete_id === 'string' ? body.athlete_id.trim() : '';
    const threadId = typeof body?.thread_id === 'string' ? body.thread_id.trim() : '';
    if ((athleteId ? 1 : 0) + (threadId ? 1 : 0) !== 1) {
      throw new Error('Missing athlete_id or thread_id: send exactly one.');
    }
    if (athleteId.length > 300) {
      throw new ValidationError('athlete_id is too long.');
    }

    const item = athleteId
      ? await startFamilyThread({
        organizationId: principal.organizationId,
        accountId: principal.accountId,
        athleteId,
        text: body?.text,
      })
      : await writeAgainInFamilyThread({
        organizationId: principal.organizationId,
        accountId: principal.accountId,
        threadId,
        text: body?.text,
      });
    return NextResponse.json({ ok: true, item }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
