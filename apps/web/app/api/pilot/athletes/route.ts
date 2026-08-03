import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { validateAthletePayload } from '@/src/server/pilot/validation';
import { insertAthleteIfAbsent } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    // Only organization admins can create athlete roster records. Coaches work with
    // existing athletes; roster management (adding/removing people) is an admin responsibility.
    requireRole(principal, ['organization_admin']);

    const body = await request.json();
    const payload = validateAthletePayload(body);

    // Create-only, and enforced by the primary key rather than by a prior
    // read: an "on conflict do update" here would silently overwrite an
    // existing athlete's name, dob, weight class, gym status, emergency
    // contact, active flag and coach assignment. That was tolerable while
    // this route was only driven by the gate scripts with generated ids; it
    // is a live data-loss hazard now that an admin hand-types the id in the
    // roster UI, where a typo can land on a real teammate.
    const created = await insertAthleteIfAbsent(principal.organizationId, payload);
    if (!created) {
      throw new Error(`Athlete record already exists: ${payload.athlete_id}`);
    }

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'athlete',
      entity_id: payload.athlete_id,
      details: { coach_id: payload.coach_id },
    });

    return NextResponse.json({ ok: true, athlete_id: payload.athlete_id });
  } catch (error) {
    return jsonError(error);
  }
}
