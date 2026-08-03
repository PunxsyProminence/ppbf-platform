import { NextResponse, type NextRequest } from 'next/server';

import { requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { validateAthletePayload } from '@/src/server/pilot/validation';
import { getAthleteById, getCoachById, insertAthleteIfAbsent } from '@/src/server/pilot/entities';
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

    const coachExists = await getCoachById(principal.organizationId, payload.coach_id);
    if (!coachExists) {
      throw new Error('Not found: coach not found in this organization');
    }

    // Create-only, and enforced by the primary key rather than by a prior
    // read: an "on conflict do update" here would silently overwrite an
    // existing athlete's name, dob, weight class, gym status, emergency
    // contact, active flag and coach assignment. That was tolerable while
    // this route was only driven by the gate scripts with generated ids; it
    // is a live data-loss hazard now that an admin hand-types the id in the
    // roster UI, where a typo can land on a real teammate.
    const created = await insertAthleteIfAbsent(principal.organizationId, payload);
    if (!created) {
      // Name the athlete already holding the id. The admin hand-typed it, and
      // "ath-014 is taken" leaves them unable to tell a typo that landed on a
      // teammate apart from a record they created themselves and forgot. The
      // read is only reached on a collision, and only inside the caller's own
      // organization, so it discloses nothing they could not already list.
      const existing = await getAthleteById(principal.organizationId, payload.athlete_id);
      throw new Error(
        existing
          ? `Athlete record already exists: ${payload.athlete_id} belongs to ${existing.full_name}`
          : `Athlete record already exists: ${payload.athlete_id}`,
      );
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
