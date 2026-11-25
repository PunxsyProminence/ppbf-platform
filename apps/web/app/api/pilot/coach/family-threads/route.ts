// /api/pilot/coach/family-threads -- the messages guardians start to the coach,
// and the gym's answers (W4 item 4, scrub FAM-09). Staff only, the gate of
// "Post to Family" and coach/family-message-replies (Overwatch Q3 A on #2161).
//
// GET ?athlete_id=: every thread on that athlete (familyThreads.ts).
// POST { thread_id, text }: answer under a thread; the athlete gate runs on the
// thread's athlete in replyInFamilyThread. Nothing is sent (W4-1's, Q1.9).
import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { ValidationError } from '@/src/server/pilot/errors';
import { listFamilyThreadsForStaff, replyInFamilyThread } from '@/src/server/pilot/familyThreads';
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
    // PostgreSQL text cannot hold a NUL character: a 400, not a failed query.
    if (athleteId.length > 300 || athleteId.includes('\u0000')) {
      throw new ValidationError('athlete_id is not an athlete id.');
    }
    await assertActorCanAccessAthlete(principal, athleteId);

    const items = await listFamilyThreadsForStaff(
      { organizationId: principal.organizationId, accountId: principal.accountId, role: principal.role },
      athleteId,
    );
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['coach', 'organization_admin', 'admin']);

    const body = (await request.json().catch(() => null)) as { thread_id?: unknown; text?: unknown } | null;
    const threadId = typeof body?.thread_id === 'string' ? body.thread_id.trim() : '';
    if (!threadId) {
      throw new Error('Missing thread_id');
    }

    const item = await replyInFamilyThread(
      { organizationId: principal.organizationId, accountId: principal.accountId, role: principal.role },
      { threadId, text: body?.text },
    );
    return NextResponse.json({ ok: true, item }, { status: 201 });
  } catch (error) {
    return jsonError(error);
  }
}
