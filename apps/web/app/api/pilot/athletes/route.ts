import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { validateAthletePayload } from '@/src/server/pilot/validation';
import { upsertAthlete } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'coach']);

    const body = await request.json();
    const payload = validateAthletePayload(body);

    if (principal.role === 'coach' && payload.coach_id !== principal.accountId) {
      throw new Error('Forbidden: coach can only create athletes assigned to self');
    }

    await upsertAthlete(payload);

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      entity_type: 'athlete',
      entity_id: payload.athlete_id,
      details: { coach_id: payload.coach_id },
    });

    return NextResponse.json({ ok: true, athlete_id: payload.athlete_id });
  } catch (error) {
    return jsonError(error);
  }
}
