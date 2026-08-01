import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, assertAthleteUpdateAllowed, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import type { PilotAthlete } from '@/src/server/pilot/contracts';
import { getAthleteById, upsertAthlete } from '@/src/server/pilot/entities';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { validateAthletePayload } from '@/src/server/pilot/validation';

export const runtime = 'nodejs';

// The fields a correction can move. athlete_id keys the record, and the two
// timestamps are bookkeeping, so neither belongs in a list of what a person
// changed about a child.
const CORRECTABLE_FIELDS = [
  'full_name',
  'dob',
  'weight_class',
  'gym_status',
  'emergency_contact',
  'coach_id',
] as const;

/**
 * pilot.athletes.dob is a `date` column, which node-postgres parses to a Date
 * at local midnight while the request carries a YYYY-MM-DD string. Rebuilding
 * the string from local parts inverts that parse in any timezone, so a
 * date of birth is not reported as changed on every save.
 */
function comparable(value: unknown): string {
  if (value instanceof Date) {
    const month = `${value.getMonth() + 1}`.padStart(2, '0');
    const day = `${value.getDate()}`.padStart(2, '0');
    return `${value.getFullYear()}-${month}-${day}`;
  }

  return typeof value === 'string' ? value.trim() : String(value);
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['organization_admin', 'coach', 'athlete']);

    const payload = validateAthletePayload(await request.json());
    await assertActorCanAccessAthlete(principal, payload.athlete_id);

    const current = await getAthleteById(principal.organizationId, payload.athlete_id);
    if (!current) {
      throw new Error('Missing athlete record');
    }

    assertAthleteUpdateAllowed(principal, current, payload);
    await upsertAthlete(principal.organizationId, payload);

    // Field names only, never their values: audit details are mirrored into
    // SHADOW's event stream, so a correction to a minor's name, date of birth
    // or emergency contact must not copy it there. Offboarding is called out
    // separately because "who took this child off the roster, and when" is a
    // question the record has to be able to answer on its own.
    const changedFields = CORRECTABLE_FIELDS.filter(
      (field) => comparable((current as PilotAthlete)[field]) !== comparable(payload[field]),
    );

    await writePilotAuditEvent({
      event_type: 'update',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'athlete',
      entity_id: payload.athlete_id,
      details: {
        changed_fields: changedFields,
        ...(current.active_flag !== payload.active_flag
          ? { active_flag_change: payload.active_flag ? 'reactivated' : 'deactivated' }
          : {}),
      },
    });

    return NextResponse.json({ ok: true, athlete_id: payload.athlete_id });
  } catch (error) {
    return jsonError(error);
  }
}
