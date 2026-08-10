import { NextResponse, type NextRequest } from 'next/server';

import { assertActorCanAccessAthlete, requireRole } from '@/src/server/pilot/access';
import { writePilotAuditEvent } from '@/src/server/pilot/audit';
import { jsonError, requirePrincipal } from '@/src/server/pilot/http';
import { createCoachObservation } from '@/src/server/pilot/intake';

export const runtime = 'nodejs';

/**
 * Capabilities #95/#96: a guardian reporting something getting in the way
 * of their child training -- no ride, an unsafe walk, a barrier at home --
 * had no write path at all. `pilot.coach_observations.note_type` is
 * unconstrained text (same as #125's reuse), so this rides on the existing
 * table rather than a new one; `note_type` is one of exactly two values,
 * not an invented taxonomy.
 *
 * Deliberately its OWN route rather than adding 'parent' to
 * intake/domain-upsert's role gate: that route's `requireRole` covers seven
 * OTHER entity types (medical, waivers, attendance, assessments...) a
 * guardian must not be able to write through this door. Narrow surface,
 * narrow route.
 */
const BARRIER_TYPES = new Set<string>(['home', 'transportation']);
const NOTE_TYPE_BY_BARRIER: Record<string, string> = {
  home: 'home_barrier',
  transportation: 'transportation_barrier',
};

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
}

interface BarrierReportRequestBody {
  athleteId?: unknown;
  barrierType?: unknown;
  description?: unknown;
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePrincipal(request);
    requireRole(principal, ['parent']);

    const body = (await request.json().catch(() => ({}))) as BarrierReportRequestBody;
    if (
      !boundedString(body.athleteId, 300)
      || typeof body.barrierType !== 'string'
      || !BARRIER_TYPES.has(body.barrierType)
      || !boundedString(body.description, 4000)
    ) {
      return NextResponse.json(
        { ok: false, error: 'Barrier report payload is invalid: athleteId, barrierType ("home" or "transportation"), and description are required.' },
        { status: 400 },
      );
    }

    await assertActorCanAccessAthlete(principal, body.athleteId);

    const noteId = await createCoachObservation({
      organizationId: principal.organizationId,
      athleteId: body.athleteId,
      coachAccountId: principal.accountId,
      noteType: NOTE_TYPE_BY_BARRIER[body.barrierType],
      noteText: body.description,
    });

    await writePilotAuditEvent({
      event_type: 'create',
      actor_account_id: principal.accountId,
      actor_role: principal.role,
      organization_id: principal.organizationId,
      entity_type: 'parent_barrier_report',
      entity_id: noteId,
      details: { athlete_id: body.athleteId, barrier_type: body.barrierType },
    });

    return NextResponse.json({ ok: true, note_id: noteId });
  } catch (error) {
    return jsonError(error);
  }
}
