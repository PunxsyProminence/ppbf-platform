import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, assertAthleteUpdateAllowed, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getAthleteById, upsertAthlete } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { validateAthletePayload } from '@/src/server/pilot/validation';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'coach', 'athlete']);

    const payload = validateAthletePayload(await request.json());
    await assertActorCanAccessAthlete(principal, payload.athlete_id);

    const current = await getAthleteById(payload.athlete_id);
    if (!current) {
      throw new Error('Missing athlete record');
    }

    assertAthleteUpdateAllowed(principal, current, payload);
    await upsertAthlete(payload);

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      entity_type: 'athlete',
      entity_id: payload.athlete_id,
      details: {},
    });

    return NextResponse.json({ ok: true, athlete_id: payload.athlete_id });
  } catch (error) {
    return jsonError(error);
  }
}
