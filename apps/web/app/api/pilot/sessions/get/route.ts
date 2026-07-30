import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { getSessionById } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete']);

    const body = (await request.json()) as { session_id?: string };
    const sessionId = body.session_id?.trim() || '';
    if (!sessionId) {
      throw new Error('Missing session_id');
    }

    const sessionRecord = await getSessionById(principal.organizationId, sessionId);
    if (!sessionRecord) {
      return NextResponse.json({ found: false });
    }

    await assertActorCanAccessAthlete(principal, sessionRecord.athlete_id);
    return NextResponse.json({ found: true, session: sessionRecord });
  } catch (error) {
    return jsonError(error);
  }
}
