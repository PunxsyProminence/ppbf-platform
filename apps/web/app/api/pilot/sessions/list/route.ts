import { NextResponse, type NextRequest } from 'next/server';

import { getSessionsByAthlete } from '@/src/server/pilot/entities';
import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { jsonError, parseSafeLimit, requirePrincipal } from '@/src/server/pilot/http';
import { sweepInactiveSessionsOnRead } from '@/src/server/pilot/sessionAutoClose';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete']);

    const athleteId = request.nextUrl.searchParams.get('athlete_id');
    if (!athleteId) throw new Error('Missing athlete_id');

    // See goals/list/route.ts: one caller, no completeness-dependent
    // consumer, so a real default cap applies rather than opt-in-only.
    const limit = parseSafeLimit(request.nextUrl.searchParams.get('limit'), 200, 500);
    if (limit === null) {
      return NextResponse.json({ error: 'Invalid limit parameter' }, { status: 400 });
    }

    await assertActorCanAccessAthlete(principal, athleteId);
    // Lazy auto-close (OD-2026-10-06-024 Q4): before anyone reads this
    // organization's sessions, close the ones nobody checked out of that
    // have had no saved activity for 20 minutes, so the list never shows a
    // stale open row as current. Org-wide, not just this athlete, because the
    // rule is about the record being right, not about who is looking. It
    // never throws; a failed sweep is logged and the list still answers.
    await sweepInactiveSessionsOnRead(principal.organizationId);
    const sessions = await getSessionsByAthlete(principal.organizationId, athleteId, { limit });
    return NextResponse.json({ items: sessions });
  } catch (error) {
    return jsonError(error);
  }
}
