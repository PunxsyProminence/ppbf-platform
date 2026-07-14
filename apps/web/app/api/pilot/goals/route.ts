import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { upsertGoal } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { validateGoalPayload } from '@/src/server/pilot/validation';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['admin', 'coach', 'athlete']);

    const payload = validateGoalPayload(await request.json());
    await assertActorCanAccessAthlete(principal, payload.athlete_id);

    await upsertGoal(payload);

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      entity_type: 'goal',
      entity_id: payload.goal_id,
      details: { athlete_id: payload.athlete_id },
    });

    return NextResponse.json({ ok: true, goal_id: payload.goal_id });
  } catch (error) {
    return jsonError(error);
  }
}
