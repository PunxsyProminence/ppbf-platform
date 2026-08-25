import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getSessionById, upsertSession } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { validateSessionPayload } from '@/src/server/pilot/validation';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete']);

    const payload = validateSessionPayload(await request.json());
    await assertActorCanAccessAthlete(principal, payload.athlete_id);

    // upsertSession is UPDATE-first keyed on session_id alone, so a POST with
    // an EXISTING session_id rewrites that row -- including reassigning its
    // athlete_id. Authorizing only payload.athlete_id (the caller's own
    // athlete) let any athlete or coach hijack another athlete's session by
    // reusing its id. Authorize the STORED owner too, exactly as
    // sessions/update/route.ts already does; a genuinely new id has no stored
    // owner and this is a no-op.
    const existing = await getSessionById(principal.organizationId, payload.session_id);
    if (existing) {
      await assertActorCanAccessAthlete(principal, existing.athlete_id);
    }

    await upsertSession(principal.organizationId, payload);

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'session',
      entity_id: payload.session_id,
      details: { athlete_id: payload.athlete_id },
    });

    return NextResponse.json({ ok: true, session_id: payload.session_id });
  } catch (error) {
    return jsonError(error);
  }
}
