import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { upsertSession } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { validateSessionPayload } from '@/src/server/pilot/validation';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'coach', 'athlete']);

    const payload = validateSessionPayload(await request.json());
    await assertActorCanAccessAthlete(principal, payload.athlete_id);

    await upsertSession(payload);

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      entity_type: 'session',
      entity_id: payload.session_id,
      details: { athlete_id: payload.athlete_id },
    });

    return NextResponse.json({ ok: true, session_id: payload.session_id });
  } catch (error) {
    return jsonError(error);
  }
}
