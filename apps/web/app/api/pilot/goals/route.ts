import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { getGoalById, upsertGoal } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { validateGoalPayload } from '@/src/server/pilot/validation';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete']);

    const payload = validateGoalPayload(await request.json());
    await assertActorCanAccessAthlete(principal, payload.athlete_id);

    // upsertGoal is UPDATE-first keyed on goal_id alone, so a POST with an
    // EXISTING goal_id rewrites that row -- including reassigning its
    // athlete_id. Authorizing only payload.athlete_id let any athlete or coach
    // overwrite another athlete's goal by reusing its id. Authorize the STORED
    // owner too, exactly as goals/update/route.ts already does; a genuinely
    // new id has no stored owner and this is a no-op.
    const existing = await getGoalById(principal.organizationId, payload.goal_id);
    if (existing) {
      await assertActorCanAccessAthlete(principal, existing.athlete_id);
    }

    await upsertGoal(principal.organizationId, payload);

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'goal',
      entity_id: payload.goal_id,
      details: { athlete_id: payload.athlete_id },
    });

    return NextResponse.json({ ok: true, goal_id: payload.goal_id });
  } catch (error) {
    return jsonError(error);
  }
}
